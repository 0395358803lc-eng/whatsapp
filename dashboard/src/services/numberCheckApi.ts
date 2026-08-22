import { API_BASE_URL, type CheckNumberResponse } from './api';

export interface NumberCheckRequestError extends Error {
  status?: number;
  code?: string;
  retryAfterSeconds?: number;
}

export type NumberCheckFailureKind = 'invalid' | 'auth' | 'session' | 'unavailable' | 'error';

export class NumberCheckFailure extends Error {
  constructor(
    public readonly kind: NumberCheckFailureKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'NumberCheckFailure';
  }
}

export interface NumberCheckRetryNotice {
  attempt: number;
  delayMs: number;
  status?: number;
}

const MAX_RETRIES = 2;
const MAX_BACKOFF_MS = 30_000;

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function backoffMs(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds !== undefined) return Math.min(retryAfterSeconds * 1000, MAX_BACKOFF_MS);
  const base = Math.min(2000 * 2 ** attempt, MAX_BACKOFF_MS);
  const jitter = Math.floor(Math.random() * Math.min(500, Math.max(1, Math.floor(base * 0.2))));
  return Math.min(base + jitter, MAX_BACKOFF_MS);
}

/**
 * Abortable Number Checker request. Kept separate from the shared API client so the bulk workflow
 * can cancel an in-flight lookup without widening the generic request surface for unrelated pages.
 */
export async function checkNumberAbortable(
  sessionId: string,
  number: string,
  signal: AbortSignal,
): Promise<CheckNumberResponse> {
  const apiKey = sessionStorage.getItem('openwa_api_key');
  const response = await fetch(
    `${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/contacts/check/${encodeURIComponent(number)}`,
    {
      signal,
      headers: { ...(apiKey ? { 'X-API-Key': apiKey } : {}) },
    },
  );

  if (!response.ok) {
    let payload: { message?: string | string[]; code?: string } = {};
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      // Preserve the HTTP status even when an upstream/proxy returns a non-JSON error body.
    }

    const message = Array.isArray(payload.message)
      ? payload.message.join(', ')
      : payload.message || `Request failed with status ${response.status}`;
    const error = new Error(message) as NumberCheckRequestError;
    error.status = response.status;
    if (typeof payload.code === 'string') error.code = payload.code;
    error.retryAfterSeconds = parseRetryAfter(response.headers.get('Retry-After'));
    throw error;
  }

  return response.json() as Promise<CheckNumberResponse>;
}

/**
 * Retry only failures that say something about the request path/transport, never a successful
 * `exists:false` response. 429 honours Retry-After; 503/network/5xx use bounded exponential backoff.
 */
export async function checkNumberWithRetry(
  sessionId: string,
  number: string,
  signal: AbortSignal,
  onRetry?: (notice: NumberCheckRetryNotice) => void,
): Promise<CheckNumberResponse> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await checkNumberAbortable(sessionId, number, signal);
    } catch (error) {
      if (isAbortError(error)) throw error;

      const requestError = error as NumberCheckRequestError;
      const status = requestError.status;
      if (status === 400) throw new NumberCheckFailure('invalid', requestError.message, status);
      if (status === 401 || status === 403) throw new NumberCheckFailure('auth', requestError.message, status);
      if (status === 409) throw new NumberCheckFailure('session', requestError.message, status);

      const retryable = status === 429 || status === 503 || status === undefined || (status >= 500 && status <= 599);
      if (retryable && attempt < MAX_RETRIES) {
        const delayMs = backoffMs(attempt, status === 429 ? requestError.retryAfterSeconds : undefined);
        onRetry?.({ attempt: attempt + 1, delayMs, status });
        await delay(delayMs, signal);
        continue;
      }

      if (retryable) {
        throw new NumberCheckFailure('unavailable', requestError.message || 'WhatsApp lookup unavailable', status);
      }
      throw new NumberCheckFailure('error', requestError.message || 'Number check failed', status);
    }
  }
}
