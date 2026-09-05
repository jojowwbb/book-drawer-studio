import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createBook, exportBook, getBook, pollUntilState } from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('createBook posts JSON and returns book_id', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('/api/books');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        theme: '孩子怕黑', style: 'watercolor', lang: 'zh', enhance: false,
      });
      return jsonResponse({ book_id: 'b1' }, 201);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { book_id } = await createBook({
      theme: '孩子怕黑', style: 'watercolor', lang: 'zh', enhance: false,
    });
    expect(book_id).toBe('b1');
  });

  it('getBook parses status payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ book_id: 'b1', state: 'ready', progress: { pages_done: 3, pages_total: 3 } }),
    ));
    const status = await getBook('b1');
    expect(status.state).toBe('ready');
    expect(status.progress.pages_done).toBe(3);
  });

  it('throws ApiError with status and payload on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ error: 'input_rejected', reason: 'blocked' }, 400),
    ));
    const err = await createBook({
      theme: 'x', style: 'watercolor', lang: 'zh', enhance: false,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).payload).toEqual({ error: 'input_rejected', reason: 'blocked' });
  });

  it('pollUntilState resolves when a target state is reached', async () => {
    const states = ['pages_generating', 'ready'];
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ book_id: 'b1', state: states.shift() ?? 'ready', progress: { pages_done: 1, pages_total: 3 } }),
    ));
    const status = await pollUntilState('b1', ['ready'], { intervalMs: 1 });
    expect(status.state).toBe('ready');
  });

  it('pollUntilState throws when pipeline enters a failed state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({
        book_id: 'b1', state: 'failed_pages_generating', error: 'boom',
        progress: { pages_done: 0, pages_total: 3 },
      }),
    ));
    await expect(pollUntilState('b1', ['ready'], { intervalMs: 1 })).rejects.toThrow(/boom/);
  });

  it('exportBook posts langs and returns state', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('/api/books/b1/export');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ langs: ['zh'] });
      return jsonResponse({ state: 'exporting' }, 202);
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await exportBook('b1', ['zh']);
    expect(res.state).toBe('exporting');
  });
});
