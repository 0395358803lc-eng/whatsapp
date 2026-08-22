import { ExecutionContext } from '@nestjs/common';
import { ThrottlerException, ThrottlerStorage } from '@nestjs/throttler';
import { NumberCheckRateLimitGuard } from './number-check-rate-limit.guard';

function contextFor(request: Record<string, unknown>, response: { setHeader: jest.Mock }): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

describe('NumberCheckRateLimitGuard', () => {
  const storage = { increment: jest.fn() };
  const guard = new NumberCheckRateLimitGuard(storage as unknown as ThrottlerStorage);

  beforeEach(() => jest.clearAllMocks());

  it('tracks both API-key/session and session-wide buckets', async () => {
    storage.increment.mockResolvedValue({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 });
    const response = { setHeader: jest.fn() };
    const context = contextFor({ apiKey: { id: 'key-1' }, params: { sessionId: 's1' } }, response);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(storage.increment).toHaveBeenNthCalledWith(1, 'key-1:s1', 60000, 30, 60000, 'number-check-key');
    expect(storage.increment).toHaveBeenNthCalledWith(2, 's1', 60000, 60, 60000, 'number-check-session');
  });

  it('returns Retry-After and rejects when either bucket is blocked', async () => {
    storage.increment
      .mockResolvedValueOnce({ totalHits: 31, timeToExpire: 42, isBlocked: true, timeToBlockExpire: 42 })
      .mockResolvedValueOnce({ totalHits: 2, timeToExpire: 50, isBlocked: false, timeToBlockExpire: 0 });
    const response = { setHeader: jest.fn() };
    const context = contextFor({ apiKey: { id: 'key-1' }, params: { sessionId: 's1' } }, response);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ThrottlerException);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '42');
  });

  it('fails closed when the authenticated rate-limit identity is unavailable', async () => {
    const response = { setHeader: jest.fn() };
    const context = contextFor({ params: { sessionId: 's1' } }, response);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ThrottlerException);
    expect(storage.increment).not.toHaveBeenCalled();
  });
});
