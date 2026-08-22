import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerException, ThrottlerStorage } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { ApiKey } from '../auth/entities/api-key.entity';

interface NumberCheckRequest extends Request {
  apiKey?: ApiKey;
  params: Request['params'] & { sessionId?: string };
}

const DEFAULT_KEY_LIMIT = 30;
const DEFAULT_KEY_WINDOW_SECONDS = 60;
const DEFAULT_SESSION_LIMIT = 60;
const DEFAULT_SESSION_WINDOW_SECONDS = 60;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

@Injectable()
export class NumberCheckRateLimitGuard implements CanActivate {
  constructor(private readonly storage: ThrottlerStorage) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<NumberCheckRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    const apiKeyId = request.apiKey?.id;
    const sessionId = request.params.sessionId;

    // ApiKeyGuard runs globally before method guards, so authenticated requests have both values.
    // Fail closed here if that contract is ever broken instead of collapsing callers into one bucket.
    if (!apiKeyId || !sessionId) {
      throw new ThrottlerException('Number-check rate limit identity is unavailable');
    }

    const keyLimit = positiveInt(process.env.NUMBER_CHECK_RATE_LIMIT, DEFAULT_KEY_LIMIT);
    const keyWindowMs = positiveInt(process.env.NUMBER_CHECK_RATE_WINDOW_SECONDS, DEFAULT_KEY_WINDOW_SECONDS) * 1000;
    const sessionLimit = positiveInt(process.env.NUMBER_CHECK_SESSION_RATE_LIMIT, DEFAULT_SESSION_LIMIT);
    const sessionWindowMs =
      positiveInt(process.env.NUMBER_CHECK_SESSION_RATE_WINDOW_SECONDS, DEFAULT_SESSION_WINDOW_SECONDS) * 1000;

    const [keyRecord, sessionRecord] = await Promise.all([
      this.storage.increment(`${apiKeyId}:${sessionId}`, keyWindowMs, keyLimit, keyWindowMs, 'number-check-key'),
      this.storage.increment(sessionId, sessionWindowMs, sessionLimit, sessionWindowMs, 'number-check-session'),
    ]);

    if (keyRecord.isBlocked || sessionRecord.isBlocked) {
      const retryAfter = Math.max(
        keyRecord.isBlocked ? keyRecord.timeToBlockExpire || keyRecord.timeToExpire : 0,
        sessionRecord.isBlocked ? sessionRecord.timeToBlockExpire || sessionRecord.timeToExpire : 0,
        1,
      );
      response.setHeader('Retry-After', String(retryAfter));
      throw new ThrottlerException('Too many WhatsApp number-check requests');
    }

    return true;
  }
}
