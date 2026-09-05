import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { BookSpecSchema } from '@pb/renderer';
import { FakeImageProvider, FakeModerationProvider, createFakeProviders } from '@pb/ai-core';
import { buildApp } from './api';
import { clipPathFor, type ClipSource, type GenerateClipArgs } from './export/clip-source';
import { AssetStore } from './asset-store';

let dir: string;
let store: AssetStore;
let app: FastifyInstance;
let imageCalls: number;
let imageFailUntil: number;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pb-e2e-'));
  store = new AssetStore(dir);
  imageCalls = 0;
  imageFailUntil = 0;
  const base = createFakeProviders();
  const flakyImage = new FakeImageProvider();
  const providers = {
    ...base,
    image: {
      name: 'flaky',
      generateImage: async (req: Parameters<FakeImageProvider['generateImage']>[0]) => {
        imageCalls += 1;
        if (imageCalls <= imageFailUntil) throw new Error('flaky image backend');
        return flakyImage.generateImage(req);
      },
    },
  };
  app = await buildApp({ voiceReview: false, dataDir: dir, pageSize: { width: 64, height: 36 }, providers, clipSource: stubClipSource() });
  await app.ready();
});

function stubClipSource(): ClipSource {
  const clipCalls: GenerateClipArgs[] = [];
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

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function waitForState(id: string, states: string[], timeoutMs = 30000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.inject({ method: 'GET', url: `/api/books/${id}` });
    const body = res.json() as Record<string, unknown>;
    if (states.includes(body.state as string)) return body;
    if (Date.now() > deadline) throw new Error(`timeout: last state=${String(body.state)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('end-to-end pipeline flow', () => {
  it('theme → ready with downloadable renderer-valid BookSpec', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/books',
      payload: { theme: '小刺猬的第一场雪', page_count: 4 },
    });
    expect(created.statusCode).toBe(201);
    const { book_id } = created.json() as { book_id: string };
    const body = await waitForState(book_id, ['ready']);

    const preview = body.preview as { book_specs: Record<string, string> };
    expect(preview.book_specs.en).toBeUndefined();
    for (const lang of ['zh'] as const) {
      const res = await app.inject({ method: 'GET', url: preview.book_specs[lang] });
      expect(res.statusCode).toBe(200);
      const book = BookSpecSchema.parse(res.json());
      // 4 正文页 + 1 片头幕
      expect(book.pages).toHaveLength(5);
      expect(book.pages[0]!.page_id).toBe('title');
      for (const page of book.pages.slice(1)) {
        const bgRes = await app.inject({ method: 'GET', url: page.background.src });
        expect(bgRes.statusCode).toBe(200);
        expect(bgRes.headers['content-type']).toContain('image/png');
        expect(page.duration_ms).toBe(5000);
        for (const subject of page.subjects) {
          const sRes = await app.inject({ method: 'GET', url: subject.src });
          expect(sRes.statusCode).toBe(200);
        }
      }
    }
  }, 60000);

  it('failure → resume → ready, without redoing the story stage', async () => {
    imageFailUntil = imageCalls + 999; // 图像后端持续故障
    const created = await app.inject({
      method: 'POST',
      url: '/api/books',
      payload: { theme: '会飞的房子', page_count: 3 },
    });
    const { book_id } = created.json() as { book_id: string };
    await waitForState(book_id, ['failed_pages_generating']);

    imageFailUntil = imageCalls; // 故障窗口结束
    const resumed = await app.inject({ method: 'POST', url: `/api/books/${book_id}/resume` });
    expect(resumed.statusCode).toBe(202);
    const body = await waitForState(book_id, ['ready']);
    expect((body.preview as { book_specs: object }).book_specs).toBeDefined();
  }, 60000);

  it('moderation rejection loop ends in ready with v2 story', async () => {
    const mod = new FakeModerationProvider({
      rejectTextWhen: (t) => (t.includes('v1') ? 'too scary' : undefined),
    });
    const base = createFakeProviders();
    const strict = await buildApp({ voiceReview: false,
      dataDir: dir,
      pageSize: { width: 32, height: 18 },
      providers: { ...base, moderation: mod },
      clipSource: stubClipSource(),
    });
    await strict.ready();
    try {
      const created = await strict.inject({
        method: 'POST',
        url: '/api/books',
        payload: { theme: '打雷的夜晚', page_count: 3 },
      });
      const { book_id } = created.json() as { book_id: string };
      const deadline = Date.now() + 30000;
      let state = '';
      for (;;) {
        const res = await strict.inject({ method: 'GET', url: `/api/books/${book_id}` });
        state = (res.json() as { state: string }).state;
        if (state === 'ready' || state.startsWith('failed_')) break;
        if (Date.now() > deadline) throw new Error(`timeout at ${state}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(state).toBe('ready');
    } finally {
      await strict.close();
    }
  }, 60000);
});
