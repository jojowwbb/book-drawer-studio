// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BookSpec } from '@pb/renderer';
import { loadBookSpec, pageStartTimes } from './spec';

const fixture = {
  id: 'b1-zh',
  pages: [
    {
      page_id: 'p1',
      duration_ms: 5200,
      camera: { type: 'ken_burns_in', intensity: 0.5 },
      background: { src: '/assets/books/b1/pages/p1/background.png' },
    },
    {
      page_id: 'p2',
      duration_ms: 3000,
      camera: { type: 'static_breath', intensity: 0.5 },
      background: { src: '/assets/books/b1/pages/p2/background.png' },
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('loadBookSpec', () => {
  it('fetches with no-store and validates through BookSpecSchema', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('/assets/books/b1/book_specs/zh.json');
      expect(init?.cache).toBe('no-store');
      return new Response(JSON.stringify(fixture), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const spec = await loadBookSpec('/assets/books/b1/book_specs/zh.json');
    expect(spec.id).toBe('b1-zh');
    expect(spec.pages[0]!.page_id).toBe('p1');
    // BookSpecSchema 默认值已填充
    expect(spec.crossfade_ms).toBe(600);
  });

  it('throws on non-2xx responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(loadBookSpec('/x')).rejects.toThrow(/failed to load book spec/);
  });
});

describe('pageStartTimes', () => {
  it('returns cumulative start times per page', () => {
    const starts = pageStartTimes(fixture as unknown as BookSpec);
    expect(starts).toEqual([0, 5200]);
  });
});
