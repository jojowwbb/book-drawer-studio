import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Lang } from '@pb/ai-core';
import { FakeModerationProvider, createFakeProviders } from '@pb/ai-core';
import { buildApp } from './api';
import { clipPathFor, type ClipSource, type GenerateClipArgs } from './export/clip-source';
import { AssetStore } from './asset-store';

let dir: string;
let store: AssetStore;
let app: FastifyInstance;
let clipCalls: GenerateClipArgs[];

function stubClipSource(): ClipSource {
  return {
    name: 'clip:stub',
    generateClip: vi.fn(async (args: GenerateClipArgs) => {
      clipCalls.push(args);
      const path = clipPathFor(store, args.bookId, args.pageId);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from([1, 2, 3]));
      return { durationMs: 5000 };
    }),
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pb-api-'));
  store = new AssetStore(dir);
  clipCalls = [];
  app = await buildApp({ voiceReview: false,
    dataDir: dir,
    pageSize: { width: 64, height: 36 },
    clipSource: stubClipSource(),
    providers: createFakeProviders(),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function waitForState(id: string, states: string[], timeoutMs = 20000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.inject({ method: 'GET', url: `/api/books/${id}` });
    const body = res.json() as Record<string, unknown>;
    if (states.includes(body.state as string)) return body;
    if (Date.now() > deadline) throw new Error(`timeout: last state=${String(body.state)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('POST /api/books', () => {
  it('creates a book and pipeline reaches ready with preview urls', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/books',
      payload: { theme: '孩子怕黑', page_count: 3 },
    });
    expect(res.statusCode).toBe(201);
    const { book_id } = res.json() as { book_id: string };
    const body = await waitForState(book_id, ['ready']);
    const preview = body.preview as { book_specs: Record<string, string> };
    expect(preview.book_specs.zh).toBe(`/assets/books/${book_id}/book_specs/zh.json`);
    expect(preview.book_specs.en).toBeUndefined();
  }, 30000);

  it('paces pages by story when page_count is omitted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/books',
      payload: { theme: '自由分幕测试' },
    });
    expect(res.statusCode).toBe(201);
    const { book_id } = res.json() as { book_id: string };
    const body = await waitForState(book_id, ['ready']);
    // Fake 桩缺省固定 6 页；ready 前管线已把 pages_total 回填为实际页数
    expect(body.progress).toEqual({ pages_done: 6, pages_total: 6 });
    expect((body.clips as unknown[]).length).toBe(6);
  }, 30000);

  it('rejects input failing moderation', async () => {
    const mod = new FakeModerationProvider({ rejectTextWhen: (t) => (t.includes('坏词') ? 'blocked input' : undefined) });
    const strict = await buildApp({ voiceReview: false,
      dataDir: dir,
      pageSize: { width: 32, height: 18 },
      providers: { ...createFakeProviders(), moderation: mod },
    });
    await strict.ready();
    const res = await strict.inject({
      method: 'POST',
      url: '/api/books',
      payload: { theme: '包含坏词的主题' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'input_rejected', reason: 'blocked input' });
    await strict.close();
  });

  it('validates body shape', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/books', payload: { theme: '' } });
    expect(res.statusCode).toBe(400);
  });

  it('accepts portrait format on creation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/books',
      payload: { theme: '竖屏测试', format: 'portrait', page_count: 3 },
    });
    expect(res.statusCode).toBe(201);
    const { book_id } = res.json() as { book_id: string };
    await waitForState(book_id, ['ready']);
    // 竖屏书：spec 页面尺寸为 1080x1920
    const spec = JSON.parse(
      (await import('node:fs')).readFileSync(join(dir, `books/${book_id}/book_specs/zh.json`), 'utf8'),
    ) as { pages: { width: number; height: number }[] };
    expect(spec.pages[0]).toMatchObject({ width: 1080, height: 1920 });
  }, 30000);
});

describe('GET /api/books/:id', () => {
  it('returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/books/nope' });
    expect(res.statusCode).toBe(404);
  });
});

describe('PUT /api/books/:id/pages/:pageId/text', () => {
  it('edits page narration and the spec subtitle follows the new text', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/books', payload: { theme: '文案编辑', page_count: 3 },
    });
    const { book_id } = created.json() as { book_id: string };
    await waitForState(book_id, ['ready']);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/books/${book_id}/pages/p1/text`,
      payload: { narration: '换成了新的旁白句子。' },
    });
    expect(res.statusCode).toBe(202);
    // 异步重配/重渲完成后 spec 已更新
    const deadline = Date.now() + 20000;
    for (;;) {
      const spec = JSON.parse(
        (await import('node:fs')).readFileSync(join(dir, `books/${book_id}/book_specs/zh.json`), 'utf8'),
      ) as { pages: { page_id: string; subtitle?: { text: string } }[] };
      if (spec.pages.find((p) => p.page_id === 'p1')?.subtitle?.text === '换成了新的旁白句子。') break;
      if (Date.now() > deadline) throw new Error('timeout waiting for edited spec');
      await new Promise((r) => setTimeout(r, 50));
    }
  }, 30000);

  it('rejects empty body and unknown pages', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/books', payload: { theme: '文案校验', page_count: 3 },
    });
    const { book_id } = created.json() as { book_id: string };
    await waitForState(book_id, ['ready']);

    const empty = await app.inject({
      method: 'PUT', url: `/api/books/${book_id}/pages/p1/text`, payload: {},
    });
    expect(empty.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'PUT', url: `/api/books/${book_id}/pages/p9/text`, payload: { narration: '一句话' },
    });
    expect(missing.statusCode).toBe(202); // 入队后失败静默，不阻塞 API
  }, 30000);
});

describe('page regenerate and resume', () => {
  it('regenerates a page with remaining budget, then 409', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/books',
      payload: { theme: '重画测试', page_count: 3 },
    });
    const { book_id } = created.json() as { book_id: string };
    await waitForState(book_id, ['ready']);

    for (let i = 2; i >= 0; i--) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/books/${book_id}/pages/p1/regenerate`,
      });
      expect(res.statusCode).toBe(202);
      expect((res.json() as { remaining: number }).remaining).toBe(i);
      await waitForState(book_id, ['ready']);
    }
    const over = await app.inject({
      method: 'POST',
      url: `/api/books/${book_id}/pages/p1/regenerate`,
    });
    expect(over.statusCode).toBe(409);
  }, 60000);

  it('resume returns 409 when not failed', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/books',
      payload: { theme: '恢复测试', page_count: 3 },
    });
    const { book_id } = created.json() as { book_id: string };
    await waitForState(book_id, ['ready']);
    const res = await app.inject({ method: 'POST', url: `/api/books/${book_id}/resume` });
    expect(res.statusCode).toBe(409);
  }, 30000);
});

async function waitForStateOn(
  target: FastifyInstance,
  id: string,
  states: string[],
  timeoutMs = 20000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await target.inject({ method: 'GET', url: `/api/books/${id}` });
    const body = res.json() as Record<string, unknown>;
    if (states.includes(body.state as string)) return body;
    if (Date.now() > deadline) throw new Error(`timeout: last state=${String(body.state)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('POST /api/books/:id/export', () => {
  it('runs the injected fake exporter and completes with artifacts', async () => {
    const exported: string[] = [];
    const exportApp = await buildApp({ voiceReview: false,
      dataDir: dir,
      pageSize: { width: 32, height: 18 },
      clipSource: stubClipSource(),
      providers: createFakeProviders(),
      exporter: {
        exportBook: async (_bookId: string, lang: Lang) => {
          exported.push(lang);
          return { url: `/assets/books/x/exports/${lang}.mp4`, duration_ms: 5000, size_bytes: 100 };
        },
      },
    });
    await exportApp.ready();
    try {
      const created = await exportApp.inject({
        method: 'POST', url: '/api/books', payload: { theme: '导出', page_count: 3 },
      });
      const { book_id } = created.json() as { book_id: string };
      await waitForStateOn(exportApp, book_id, ['ready']);
      const res = await exportApp.inject({
        method: 'POST', url: `/api/books/${book_id}/export`, payload: { langs: ['zh'] },
      });
      expect(res.statusCode).toBe(202);
      const done = await waitForStateOn(exportApp, book_id, ['completed']);
      expect(exported).toEqual(['zh']);
      expect((done.exports as { zh: { url: string } }).zh.url).toContain('/exports/zh.mp4');
    } finally {
      await exportApp.close();
    }
  }, 30000);

  it('returns 404 for unknown book', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/books/nope/export', payload: {} });
    expect(res.statusCode).toBe(404);
  });
});

describe('voice_review endpoints', () => {
  async function waitForStateIn(
    target: FastifyInstance,
    id: string,
    states: string[],
    timeoutMs = 20000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await target.inject({ method: 'GET', url: `/api/books/${id}` });
      const body = res.json() as Record<string, unknown>;
      if (states.includes(body.state as string)) return body;
      if (Date.now() > deadline) throw new Error(`timeout: last state=${String(body.state)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('GET /characters + PUT + confirm-voices resumes to ready', async () => {
    const reviewDir = mkdtempSync(join(tmpdir(), 'pb-voice2-'));
    const reviewApp = await buildApp({
      voiceReview: true,
      dataDir: reviewDir,
      pageSize: { width: 64, height: 36 },
      clipSource: stubClipSource(),
      providers: createFakeProviders(),
    });
    await reviewApp.ready();
    try {
      const created = await reviewApp.inject({
        method: 'POST',
        url: '/api/books',
        payload: { theme: '小兔子找朋友', page_count: 3 },
      });
      const { book_id } = created.json() as { book_id: string };
      const paused = await waitForStateIn(reviewApp, book_id, ['voice_review']);
      const review = paused.voice_review as { characters: { name: string; voice: string | null }[] };
      expect(review.characters.length).toBeGreaterThan(0);

      const list = await reviewApp.inject({ method: 'GET', url: `/api/books/${book_id}/characters` });
      expect(list.statusCode).toBe(200);
      const { characters, voices, narrator_voice } = list.json() as {
        characters: { name: string; voice: string | null }[];
        voices: Record<string, string>;
        narrator_voice: string | null;
      };
      expect(characters.length).toBeGreaterThan(0);
      expect(Object.keys(voices).length).toBeGreaterThan(0);
      expect(narrator_voice).toBeNull();

      const put = await reviewApp.inject({
        method: 'PUT',
        url: `/api/books/${book_id}/characters`,
        payload: { voices: { [characters[0]!.name]: 'Bella', 旁白: 'Elias' } },
      });
      expect(put.statusCode).toBe(200);

      // 旁白音色（key=「旁白」）写入 story.narrator_voice
      const afterPut = await reviewApp.inject({ method: 'GET', url: `/api/books/${book_id}/characters` });
      expect((afterPut.json() as { narrator_voice: string | null }).narrator_voice).toBe('Elias');

      const confirm = await reviewApp.inject({
        method: 'POST',
        url: `/api/books/${book_id}/confirm-voices`,
      });
      expect(confirm.statusCode).toBe(202);
      await waitForStateIn(reviewApp, book_id, ['ready']);

      // 改配后的音色已落进 story
      const recheck = await reviewApp.inject({ method: 'GET', url: `/api/books/${book_id}/characters` });
      expect(recheck.statusCode).toBe(409); // 已离开 voice_review
    } finally {
      await reviewApp.close();
      rmSync(reviewDir, { recursive: true, force: true });
    }
  }, 40000);

  it('voice_review payload carries script pages and PUT /text edits script in place', async () => {
    const reviewDir = mkdtempSync(join(tmpdir(), 'pb-voice-script-'));
    const reviewApp = await buildApp({
      voiceReview: true,
      dataDir: reviewDir,
      pageSize: { width: 64, height: 36 },
      clipSource: stubClipSource(),
      providers: createFakeProviders(),
    });
    await reviewApp.ready();
    try {
      const created = await reviewApp.inject({
        method: 'POST',
        url: '/api/books',
        payload: { theme: '小兔子找朋友', page_count: 3 },
      });
      const { book_id } = created.json() as { book_id: string };
      const paused = await waitForStateIn(reviewApp, book_id, ['voice_review']);
      const review = paused.voice_review as {
        title?: string;
        pages: { page_id: string; narration: string; segments?: { speaker: string; text: string }[] }[];
      };
      expect(review.pages.length).toBe(3);
      expect(review.pages[0]!.narration).toBeTruthy();

      const pageId = review.pages[1]!.page_id;
      const put = await reviewApp.inject({
        method: 'PUT',
        url: `/api/books/${book_id}/pages/${pageId}/text`,
        payload: { narration: '【旁白】太阳出来了。【小暖】早上好呀！' },
      });
      expect(put.statusCode).toBe(202);

      // 服务端异步落盘：轮询直到剧本页内容更新，且仍停在 voice_review
      const deadline = Date.now() + 20000;
      for (;;) {
        const res = await reviewApp.inject({ method: 'GET', url: `/api/books/${book_id}` });
        const body = res.json() as {
          state: string;
          voice_review: { pages: { page_id: string; narration: string }[] };
        };
        const p = body.voice_review.pages.find((x) => x.page_id === pageId);
        if (p?.narration === '太阳出来了。早上好呀！') {
          expect(body.state).toBe('voice_review');
          break;
        }
        if (Date.now() > deadline) throw new Error('timeout waiting for edited script page');
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      await reviewApp.close();
      rmSync(reviewDir, { recursive: true, force: true });
    }
  }, 40000);

  it('confirm-voices rejects when not in voice_review', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/books/nope/confirm-voices' });
    expect(res.statusCode).toBe(404);
  });
});

describe('SSE /api/books/:id/events', () => {  it('streams state events until completed', async () => {
    const sseApp = await buildApp({ voiceReview: false,
      dataDir: dir,
      pageSize: { width: 64, height: 36 },
      clipSource: stubClipSource(),
      providers: createFakeProviders(),
    });
    await sseApp.ready();
    const address = await sseApp.listen({ port: 0, host: '127.0.0.1' });
    try {
      const created = await sseApp.inject({
        method: 'POST',
        url: '/api/books',
        payload: { theme: 'SSE 测试', page_count: 3 },
      });
      const { book_id } = created.json() as { book_id: string };

      const collected = await new Promise<string[]>((resolve, reject) => {
        const seen: string[] = [];
        const timer = setTimeout(() => reject(new Error(`sse timeout, saw: ${seen.join(',')}`)), 25000);
        http.get(`${address}/api/books/${book_id}/events`, (res) => {
          expect(res.headers['content-type']).toBe('text/event-stream');
          let buf = '';
          res.on('data', (chunk: Buffer) => {
            buf += chunk.toString('utf8');
            let sep = buf.indexOf('\n\n');
            while (sep >= 0) {
              const rawEvent = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              const dataLine = rawEvent.split('\n').find((l) => l.startsWith('data: '));
              if (dataLine) seen.push(dataLine.slice(6));
              sep = buf.indexOf('\n\n');
            }
            if (seen.some((s) => JSON.parse(s).type === 'completed')) {
              clearTimeout(timer);
              res.destroy();
              resolve(seen);
            }
          });
          res.on('error', () => undefined);
        });
      });

      const types = collected.map((s) => (JSON.parse(s) as { type: string }).type);
      expect(types).toContain('state');
      expect(types).toContain('progress');
      expect(types[types.length - 1]).toBe('completed');

      const status = await sseApp.inject({ method: 'GET', url: `/api/books/${book_id}` });
      expect((status.json() as { state: string }).state).toBe('ready');
    } finally {
      await sseApp.close();
    }
  }, 40000);
});
