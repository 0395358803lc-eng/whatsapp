import { API_BASE_URL, type CheckNumberResponse } from './api';

export interface NumberCheckRequestError extends Error {
  status?: number;
  code?: string;
  retryAfterSeconds?: number;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
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
