import { NumberCheckThrottlerGuard } from './number-check-throttler.guard';

describe('NumberCheckThrottlerGuard', () => {
  it('keys the primary bucket on API key + session', async () => {
    const guard = Object.create(NumberCheckThrottlerGuard.prototype) as NumberCheckThrottlerGuard & {
      getTracker(req: unknown): Promise<string>;
    };
    await expect(
      guard.getTracker({ params: { sessionId: 'session-a' }, apiKey: { id: 'key-1' }, ip: '203.0.113.9' }),
    ).resolves.toBe('number-check:key:key-1:session:session-a');
  });

  it('does not share a primary bucket between API keys on the same session', async () => {
    const guard = Object.create(NumberCheckThrottlerGuard.prototype) as NumberCheckThrottlerGuard & {
      getTracker(req: unknown): Promise<string>;
    };
    const first = await guard.getTracker({ params: { sessionId: 's1' }, apiKey: { id: 'key-1' } });
    const second = await guard.getTracker({ params: { sessionId: 's1' }, apiKey: { id: 'key-2' } });
    expect(first).not.toBe(second);
  });

  it('falls back to client tracking if auth/session context is unexpectedly missing', async () => {
    const guard = Object.create(NumberCheckThrottlerGuard.prototype) as NumberCheckThrottlerGuard & {
      getTracker(req: unknown): Promise<string>;
    };
    await expect(guard.getTracker({ params: {}, ip: '203.0.113.9' })).resolves.toContain('203.0.113.9');
  });

  describe('tier resolution from the environment', () => {
    const KEYS = ['NUMBER_CHECK_RATE_TTL_MS', 'NUMBER_CHECK_KEY_SESSION_LIMIT', 'NUMBER_CHECK_SESSION_LIMIT'] as const;
    const saved: Array<[string, string | undefined]> = [];

    beforeEach(() => {
      saved.length = 0;
      for (const key of KEYS) saved.push([key, process.env[key]]);
    });

    afterEach(() => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      jest.restoreAllMocks();
    });

    type Tier = { name: string; limit: number; ttl: number; getTracker?: (req: unknown) => Promise<string> };

    const resolveTiers = async (): Promise<Tier[]> => {
      const guard = Object.create(NumberCheckThrottlerGuard.prototype) as NumberCheckThrottlerGuard & {
        throttlers: Tier[];
        onModuleInit(): Promise<void>;
      };
      jest
        .spyOn(Object.getPrototypeOf(NumberCheckThrottlerGuard.prototype), 'onModuleInit')
        .mockResolvedValue(undefined);
      await guard.onModuleInit();
      return guard.throttlers;
    };

    const sizes = (tiers: Tier[]): Array<{ name: string; limit: number; ttl: number }> =>
      tiers.map(({ name, limit, ttl }) => ({ name, limit, ttl }));

    it.each(['', '   '])('treats blank values (%p) as unset, not zero', async blank => {
      process.env.NUMBER_CHECK_RATE_TTL_MS = blank;
      process.env.NUMBER_CHECK_KEY_SESSION_LIMIT = blank;
      process.env.NUMBER_CHECK_SESSION_LIMIT = blank;
      expect(sizes(await resolveTiers())).toEqual([
        { name: 'number-check-key-session', limit: 30, ttl: 60000 },
        { name: 'number-check-session', limit: 60, ttl: 60000 },
      ]);
    });

    it('falls back from zero values instead of self-DoSing the route', async () => {
      process.env.NUMBER_CHECK_RATE_TTL_MS = '0';
      process.env.NUMBER_CHECK_KEY_SESSION_LIMIT = '0';
      process.env.NUMBER_CHECK_SESSION_LIMIT = '0';
      expect(sizes(await resolveTiers())).toEqual([
        { name: 'number-check-key-session', limit: 30, ttl: 60000 },
        { name: 'number-check-session', limit: 60, ttl: 60000 },
      ]);
    });

    it('honors explicit operator limits', async () => {
      process.env.NUMBER_CHECK_RATE_TTL_MS = '10000';
      process.env.NUMBER_CHECK_KEY_SESSION_LIMIT = '7';
      process.env.NUMBER_CHECK_SESSION_LIMIT = '11';
      expect(sizes(await resolveTiers())).toEqual([
        { name: 'number-check-key-session', limit: 7, ttl: 10000 },
        { name: 'number-check-session', limit: 11, ttl: 10000 },
      ]);
    });

    it('keys the session tier only on session id so all API keys share the account cap', async () => {
      const tiers = await resolveTiers();
      const sessionTier = tiers.find(tier => tier.name === 'number-check-session');
      expect(sessionTier?.getTracker).toBeDefined();
      const first = await sessionTier!.getTracker!({ params: { sessionId: 's1' }, apiKey: { id: 'key-1' } });
      const second = await sessionTier!.getTracker!({ params: { sessionId: 's1' }, apiKey: { id: 'key-2' } });
      expect(first).toBe('number-check:session:s1');
      expect(second).toBe(first);
    });
  });
});
