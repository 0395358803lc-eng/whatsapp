import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNumberWithRetry, NumberCheckFailure, type NumberCheckRetryNotice } from './numberCheckApi.ts';

interface FetchCall {
  input: string;
  init?: RequestInit;
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function installSessionStorage(apiKey = 'test-api-key'): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => (key === 'openwa_api_key' ? apiKey : null),
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: apiKey ? 1 : 0,
    } satisfies Storage,
  });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor);
    else delete (globalThis as typeof globalThis & { sessionStorage?: Storage }).sessionStorage;
  };
}

function installFetch(responses: Response[]): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  let index = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    const current = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!current) throw new Error('No mocked response configured');
    return current.clone();
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

async function withHttpMocks<T>(responses: Response[], run: (calls: FetchCall[]) => Promise<T>): Promise<T> {
  const restoreStorage = installSessionStorage();
  const { calls, restore } = installFetch(responses);
  try {
    return await run(calls);
  } finally {
    restore();
    restoreStorage();
  }
}

test('a successful negative WhatsApp answer is returned once and is never retried', async () => {
  await withHttpMocks(
    [response(200, { number: '84901234567', exists: false, whatsappId: null })],
    async calls => {
      const result = await checkNumberWithRetry('session/one', '84901234567', new AbortController().signal);
      assert.deepEqual(result, { number: '84901234567', exists: false, whatsappId: null });
      assert.equal(calls.length, 1);
      assert.match(calls[0].input, /sessions\/session%2Fone\/contacts\/check\/84901234567$/);
      assert.equal((calls[0].init?.headers as Record<string, string>)['X-API-Key'], 'test-api-key');
    },
  );
});

test('400, auth failures and session-not-ready responses are classified without retrying', async () => {
  const cases = [
    [400, 'invalid'],
    [401, 'auth'],
    [403, 'auth'],
    [409, 'session'],
  ] as const;

  for (const [status, kind] of cases) {
    await withHttpMocks([response(status, { message: `status ${status}` })], async calls => {
      await assert.rejects(
        checkNumberWithRetry('s1', '84901234567', new AbortController().signal),
        error => error instanceof NumberCheckFailure && error.kind === kind && error.status === status,
      );
      assert.equal(calls.length, 1, `status ${status} should not retry`);
    });
  }
});

test('429 honours Retry-After and retries before returning a successful lookup', async () => {
  await withHttpMocks(
    [
      response(429, { message: 'slow down' }, { 'Retry-After': '0' }),
      response(200, { number: '84901234567', exists: true, whatsappId: '84901234567@c.us' }),
    ],
    async calls => {
      const notices: NumberCheckRetryNotice[] = [];
      const result = await checkNumberWithRetry(
        's1',
        '84901234567',
        new AbortController().signal,
        notice => notices.push(notice),
      );
      assert.equal(calls.length, 2);
      assert.deepEqual(notices, [{ attempt: 1, delayMs: 0, status: 429 }]);
      assert.equal(result.exists, true);
      assert.equal(result.whatsappId, '84901234567@c.us');
    },
  );
});

test('repeated 429 responses stop after the bounded retry budget', async () => {
  await withHttpMocks(
    [
      response(429, { message: 'slow down' }, { 'Retry-After': '0' }),
      response(429, { message: 'still slow down' }, { 'Retry-After': '0' }),
      response(429, { message: 'still limited' }, { 'Retry-After': '0' }),
    ],
    async calls => {
      await assert.rejects(
        checkNumberWithRetry('s1', '84901234567', new AbortController().signal),
        error => error instanceof NumberCheckFailure && error.kind === 'unavailable' && error.status === 429,
      );
      assert.equal(calls.length, 3);
    },
  );
});

test('operator cancellation aborts a 503 retry before another request is sent', async () => {
  await withHttpMocks([response(503, { message: 'WhatsApp did not answer' })], async calls => {
    const controller = new AbortController();
    await assert.rejects(
      checkNumberWithRetry('s1', '84901234567', controller.signal, () => controller.abort()),
      error => error instanceof Error && error.name === 'AbortError',
    );
    assert.equal(calls.length, 1);
  });
});

test('non-retryable HTTP failures are surfaced as terminal row errors', async () => {
  await withHttpMocks([response(418, { message: 'unexpected response' })], async calls => {
    await assert.rejects(
      checkNumberWithRetry('s1', '84901234567', new AbortController().signal),
      error => error instanceof NumberCheckFailure && error.kind === 'error' && error.status === 418,
    );
    assert.equal(calls.length, 1);
  });
});
