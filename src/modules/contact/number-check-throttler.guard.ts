import { Injectable } from '@nestjs/common';
import { ProxyAwareThrottlerGuard } from '../../common/security/proxy-aware-throttler.guard';
import { resolveNonNegativeIntEnv } from '../../config/configuration';
import type { ApiKey } from '../auth/entities/api-key.entity';

type NumberCheckRequest = Record<string, unknown> & {
  params?: { sessionId?: string };
  apiKey?: Pick<ApiKey, 'id'>;
};

/**
 * Dedicated rate limits for active WhatsApp number-existence lookups.
 *
 * The global API throttler is keyed on client IP. That protects the HTTP surface, but it does not
 * protect one WhatsApp account from several API keys (or several operators behind different IPs)
 * independently enumerating numbers against the same session. Number checks are active upstream
 * queries, so they need a tighter account-aware bound.
 *
 * This route guard evaluates two independent tiers over the same window:
 *  - `number-check-key-session`: one bucket per authenticated API key + WhatsApp session.
 *  - `number-check-session`: one bucket shared by every key using the same WhatsApp session.
 *
 * As with InstanceThrottlerGuard, these tiers replace this guard instance's inherited global tier
 * list in onModuleInit instead of using @Throttle metadata. @Throttle is handler metadata and would
 * also retune the process-wide ProxyAwareThrottlerGuard for the route, coupling two unrelated limits.
 */
@Injectable()
export class NumberCheckThrottlerGuard extends ProxyAwareThrottlerGuard {
  async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    const ttl = resolveNonNegativeIntEnv(process.env.NUMBER_CHECK_RATE_TTL_MS, 60_000);
    this.throttlers = [
      {
        name: 'number-check-key-session',
        limit: resolveNonNegativeIntEnv(process.env.NUMBER_CHECK_KEY_SESSION_LIMIT, 30),
        ttl,
      },
      {
        name: 'number-check-session',
        limit: resolveNonNegativeIntEnv(process.env.NUMBER_CHECK_SESSION_LIMIT, 60),
        ttl,
        getTracker: req => this.trackSession(req),
      },
    ];
  }

  /**
   * A bare @SkipThrottle elsewhere must never accidentally disable this guard if the route is moved
   * under a controller that is globally exempted from the generic IP throttle. Number-check limits
   * are an explicit property of this active WhatsApp query, not of the surrounding controller.
   */
  protected shouldSkip(): Promise<boolean> {
    return Promise.resolve(false);
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as NumberCheckRequest;
    const sessionId = request.params?.sessionId;
    const apiKeyId = request.apiKey?.id;
    if (sessionId && apiKeyId) {
      return `number-check:key:${apiKeyId}:session:${sessionId}`;
    }
    // Defensive fallback. Under the real route the global ApiKeyGuard has already attached apiKey
    // and Nest has populated :sessionId before route guards execute. If this guard is reused or the
    // request shape changes, fall back to the trusted-proxy-aware client IP instead of sharing one
    // constant bucket.
    return super.getTracker(req);
  }

  private async trackSession(req: Record<string, unknown>): Promise<string> {
    const sessionId = (req as NumberCheckRequest).params?.sessionId;
    if (sessionId) return `number-check:session:${sessionId}`;
    return super.getTracker(req);
  }
}
