import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderHttpError, fetchJson } from './http';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('fetchJson', () => {
  it('posts JSON with headers and parses the response', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('https://api.example.com/v1/x');
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer k1');
      expect(headers['content-type']).toBe('application/json');
      expect(JSON.parse(String(init?.body))).toEqual({ q: 1 });
      return jsonResponse({ ok: true, value: 42 });
    });
    const out = await fetchJson<{ ok: boolean; value: number }>(
      'https://api.example.com/v1/x', { q: 1 },
      { fetchImpl: fetchMock as unknown as typeof fetch, headers: { authorization: 'Bearer k1' } },
    );
    expect(out.value).toBe(42);
  });

  it('retries on 5xx then succeeds', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      return calls === 1 ? jsonResponse({ e: 'boom' }, 503) : jsonResponse({ ok: 1 });
    });
    const out = await fetchJson<{ ok: number }>('https://x', {}, {
      fetchImpl: fetchMock as unknown as typeof fetch, backoffMs: 1,
    });
    expect(out.ok).toBe(1);
    expect(calls).toBe(2);
  });

  it('does not retry plain 4xx and wraps it in ProviderHttpError', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'bad key' }, 401));
    const err = await fetchJson('https://x', {}, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts slow responses with a timeout error', async () => {
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('The operation was aborted')),
          );
        }),
    );
    await expect(
      fetchJson('https://x', {}, { fetchImpl: fetchMock as unknown as typeof fetch, timeoutMs: 20, retries: 0 }),
    ).rejects.toThrow();
  });
});
