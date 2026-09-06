import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BookSpecSchema, type BookSpec } from '@pb/renderer';
import { createFakeProviders, encodeWav, hashSeed, NARRATOR, type ProviderBundle } from '@pb/ai-core';
import { AssetStore } from './asset-store';
import { BookRepo, type BookRecord } from './book-repo';
import { EventHub, type HubMessage } from './events';
import { clipPathFor, type ClipSource, type GenerateClipArgs } from './export/clip-source';
import { PAGE_IMAGE_CONCURRENCY, PORTRAIT_SIZE, Pipeline, bookPageSize } from './pipeline';
import { initialCounters } from './state-machine';

let dir: string;
let store: AssetStore;
let repo: BookRepo;
let hub: EventHub;
let providers: ProviderBundle;
let pipeline: Pipeline;
let clipCalls: GenerateClipArgs[];
const events: HubMessage[] = [];

const size = { width: 64, height: 36 };

// 每个用例独立临时目录：页资产落盘即视为「已完成不重建」，目录复用会让
// 重试/失败类用例跳过图像生成而拿到错误的 ready 状态。
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pb-pipeline-'));
  store = new AssetStore(dir);
  repo = new BookRepo(store);
  hub = new EventHub();
  hub.subscribe('b1', (m) => events.push(m));
  providers = createFakeProviders();
  clipCalls = [];
  const clipSource: ClipSource = {
    name: 'clip:stub',
    generateClip: vi.fn(async (args: GenerateClipArgs) => {
      clipCalls.push(args);
      const path = clipPathFor(store, args.bookId, args.pageId);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from([1, 2, 3]));
      return { durationMs: 5000 };
    }),
  };
  pipeline = new Pipeline(
    providers,
    repo,
    store,
    hub,
    { pageSize: size, probeDurationMs: async () => 1800, voiceReview: false },
    clipSource,
  );
  events.length = 0;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function createBook(overrides: Partial<BookRecord> = {}): BookRecord {
  return repo.create({
    id: 'b1',
    theme: '孩子怕黑，不敢一个人睡觉',
    style: 'watercolor',
    langs: ['zh'],
    enhance: false,
    page_count: 3,
    state: 'created',
    counters: initialCounters(),
    progress: { pages_done: 0, pages_total: 3 },
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  });
}

describe('Pipeline.run happy path', () => {
  it('drives created → ready and produces a schema-valid BookSpec', async () => {
    createBook();
    await pipeline.run('b1');
    expect(repo.get('b1')?.state).toBe('ready');

    const spec = JSON.parse(
      // 直接从磁盘读取并走渲染包校验
      (await import('node:fs')).readFileSync(
        join(dir, 'books/b1/book_specs', 'zh.json'), 'utf8',
      ),
    ) as unknown;
    const book = BookSpecSchema.parse(spec) as BookSpec;
    expect(book.id).toBe('b1-zh');
    // 3 正文页 + 1 片头幕
    expect(book.pages).toHaveLength(4);
    const title = book.pages[0]!;
    expect(title.page_id).toBe('title');
    expect(title.duration_ms).toBe(3600);
    expect(title.title_overlay?.title.length).toBeGreaterThan(0);
    expect(title.subtitle).toBeUndefined();
    for (const pageSpec of book.pages.slice(1)) {
      expect(pageSpec.duration_ms).toBe(5000);
      expect(pageSpec.subtitle?.text.length).toBeGreaterThan(0);
    }
    expect(events.some((e) => e.type === 'completed')).toBe(true);
    expect(events.some((e) => e.type === 'progress')).toBe(true);
  });

  it('writes image layers and per-page clips to disk', async () => {
    createBook();
    await pipeline.run('b1');
    const fs = await import('node:fs');
    expect(fs.existsSync(join(dir, 'books/b1/pages/p1/full.png'))).toBe(true);
    expect(fs.existsSync(join(dir, 'books/b1/pages/p1/background.png'))).toBe(true);
    expect(fs.existsSync(join(dir, 'books/b1/pages/p1/clip.mp4'))).toBe(true);
    const manifest = store.tryReadPageAssets('b1', 'p1');
    expect(manifest?.clip_url).toBe('/assets/books/b1/pages/p1/clip.mp4');
    expect(manifest?.clip_duration_ms).toBe(5000);
    // 3 正文页 + 1 片头幕片段
    expect(clipCalls).toHaveLength(4);
    expect(clipCalls.some((c) => c.pageId === 'title')).toBe(true);
  });

  it('is resumable mid-pipeline: completed pages are not rebuilt', async () => {    createBook();
    await pipeline.run('b1');
    const before = store.tryReadPageAssets('b1', 'p1');
    // 模拟从 pages_generating 恢复（例如进程重启）
    repo.update({ ...repo.get('b1')!, state: 'pages_generating' });
    await pipeline.run('b1');
    expect(repo.get('b1')?.state).toBe('ready');
    expect(store.tryReadPageAssets('b1', 'p1')?.seed).toBe(before?.seed);
  });

  it('lets the story provider pace pages when page_count is omitted', async () => {
    createBook({ page_count: undefined, progress: { pages_done: 0, pages_total: 0 } });
    await pipeline.run('b1');
    expect(repo.get('b1')?.state).toBe('ready');
    // Fake 桩缺省页数固定 6 页；管线回填 pages_total 供进度条使用
    const story = store.readStory('b1', 'zh');
    expect(story.pages).toHaveLength(6);
    expect(repo.get('b1')?.progress.pages_total).toBe(6);
    // 6 正文页 + 1 片头幕片段
    expect(clipCalls).toHaveLength(7);
  });

  it('forces a user-supplied title onto the story and cover', async () => {
    createBook({ title: '勇敢的小恐龙' });
    await pipeline.run('b1');
    const story = store.readStory('b1', 'zh');
    expect(story.title).toBe('勇敢的小恐龙');
    expect(story.cover?.title).toBe('勇敢的小恐龙');
    const spec = BookSpecSchema.parse(
      JSON.parse(
        (await import('node:fs')).readFileSync(
          join(dir, 'books/b1/book_specs', 'zh.json'), 'utf8',
        ),
      ),
    ) as BookSpec;
    expect(spec.pages[0]!.title_overlay?.title).toBe('勇敢的小恐龙');
  });
});

describe('Pipeline page image concurrency', () => {
  it('caps parallel page generations at PAGE_IMAGE_CONCURRENCY', async () => {
    createBook({ page_count: 10 });
    let inFlight = 0;
    let maxInFlight = 0;
    const realImage = providers.image;
    providers.image = {
      name: 'tracked-image',
      generateImage: async (req) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        const png = await realImage.generateImage(req);
        inFlight -= 1;
        return png;
      },
    };

    await pipeline.run('b1');

    expect(repo.get('b1')?.state).toBe('ready');
    // 正文页并发受 PAGE_IMAGE_CONCURRENCY 限制，片头封面任务额外并行占用 1 路
    expect(maxInFlight).toBe(Math.min(PAGE_IMAGE_CONCURRENCY, 10) + 1);
    const story = store.readStory('b1', 'zh');
    expect(story.pages).toHaveLength(10);
    // 完成一页推进一次：pages 阶段的前 10 个进度事件恰为 1..10（乱序完成但计数单调）
    const doneValues = events
      .filter((e): e is Extract<HubMessage, { type: 'progress' }> => e.type === 'progress')
      .slice(0, 10)
      .map((e) => e.progress.pages_done);
    expect(doneValues).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('Pipeline portrait format', () => {
  it('bookPageSize picks 1080x1920 for portrait and the fallback otherwise', () => {
    expect(bookPageSize({ format: 'portrait' }, size)).toEqual(PORTRAIT_SIZE);
    expect(bookPageSize({ format: 'landscape' }, size)).toEqual(size);
    expect(bookPageSize({}, size)).toEqual(size); // 旧书缺省按横版
  });

  it('renders all scenes at portrait size when the book format is portrait', async () => {
    createBook({ format: 'portrait' });
    await pipeline.run('b1');
    const spec = BookSpecSchema.parse(
      JSON.parse((await import('node:fs')).readFileSync(join(dir, 'books/b1/book_specs/zh.json'), 'utf8')),
    ) as BookSpec;
    for (const page of spec.pages) {
      expect(page.width).toBe(PORTRAIT_SIZE.width);
      expect(page.height).toBe(PORTRAIT_SIZE.height);
    }
    // 片段渲染也拿到竖屏尺寸的 sceneSpec
    expect(clipCalls.every((c) => c.sceneSpec.width === PORTRAIT_SIZE.width)).toBe(true);
  });
});

describe('Pipeline moderation loop', () => {
  it('regenerates story on rejection and passes on round 2', async () => {
    providers.moderation.checkText = async (text: string) =>
      text.includes('v1') ? { verdict: 'reject', reason: 'too scary' } : { verdict: 'pass' };
    createBook();
    await pipeline.run('b1');
    expect(repo.get('b1')?.state).toBe('ready');
    expect(repo.get('b1')?.counters.moderationRounds).toBe(1);
    const story = store.readStory('b1', 'zh');
    expect(story.title).toContain('v2');
  });

  it('fails after moderation rounds are exhausted', async () => {
    providers.moderation.checkText = async () => ({ verdict: 'reject', reason: 'always' });
    createBook();
    await pipeline.run('b1');
    expect(repo.get('b1')?.state).toBe('failed_story_moderating');
    expect(events.some((e) => e.type === 'failed')).toBe(true);
  });
});

describe('Pipeline stage retry', () => {
  it('retries a throwing image provider and succeeds within budget', async () => {
    let failures = 2;
    const realImage = providers.image;
    providers.image = {
      name: 'flaky-image',
      generateImage: async (req) => {
        if (failures-- > 0) throw new Error('transient');
        return realImage.generateImage(req);
      },
    };
    createBook();
    await pipeline.run('b1');
    expect(repo.get('b1')?.state).toBe('ready');
  });

  it('marks failed_pages_generating when retries are exhausted', async () => {
    providers.image = {
      name: 'dead-image',
      generateImage: async () => {
        throw new Error('always down');
      },
    };
    createBook();
    await pipeline.run('b1');
    expect(repo.get('b1')?.state).toBe('failed_pages_generating');
    expect(repo.get('b1')?.error).toContain('always down');
  });
});

describe('Pipeline image moderation', () => {
  it('redraws a rejected page image until it passes', async () => {
    let rejectsLeft = 1;
    providers.moderation.checkImage = async () =>
      rejectsLeft-- > 0 ? { verdict: 'reject', reason: 'bad pixels' } : { verdict: 'pass' };
    createBook();
    await pipeline.run('b1');
    expect(repo.get('b1')?.state).toBe('ready');
  });

  it('skips a persistently failing page with a placeholder and still finishes the book', async () => {
    // p2 的插画服务三次尝试（含末次软化 prompt）全部抛错，其余页正常
    const realImage = providers.image;
    const p2Seed = hashSeed('b1:p2') >>> 0;
    const p2Seeds = new Set([p2Seed, p2Seed + 101, p2Seed + 202]);
    providers.image = {
      name: 'flaky-p2',
      generateImage: async (req) => {
        if (p2Seeds.has(req.seed)) throw new Error('p2 down');
        return realImage.generateImage(req);
      },
    };
    createBook();
    await pipeline.run('b1');
    expect(repo.get('b1')?.state).toBe('ready');
    const p2 = store.tryReadPageAssets('b1', 'p2');
    expect(p2?.image_failed).toBe(true);
    expect(p2?.image_error).toContain('p2 down');
    expect(p2?.subject_urls).toEqual([]);
    // 其余页正常产出插画
    expect(store.tryReadPageAssets('b1', 'p1')?.image_failed).toBeUndefined();
    expect(store.tryReadPageAssets('b1', 'p3')?.image_failed).toBeUndefined();
    // 失败页有 SSE page_image 事件
    expect(
      events.some((e) => e.type === 'page_image' && e.page_id === 'p2' && e.status === 'failed'),
    ).toBe(true);
    // 占位页照常渲染片段与旁白，成片不阻塞
    expect(p2?.clip_url).toBeDefined();
    expect(p2?.narration_url).toBeDefined();
  });

  it('switches to the softened prompt on the final attempt', async () => {
    const realImage = providers.image;
    const p1Seed = hashSeed('b1:p1') >>> 0;
    const p1Seeds = new Set([p1Seed, p1Seed + 101, p1Seed + 202]);
    const promptOf = new Map<string, string>();
    const promptsBySeed = new Map<number, string[]>();
    providers.image = {
      name: 'tracked-image',
      generateImage: async (req) => {
        const png = await realImage.generateImage(req);
        promptOf.set(Buffer.from(png).toString('base64'), req.prompt);
        promptsBySeed.set(req.seed, [...(promptsBySeed.get(req.seed) ?? []), req.prompt]);
        return png;
      },
    };
    // 只驳回 p1 的前两次尝试（按生成图反查 seed，避免并发顺序干扰）
    let p1Rejects = 2;
    providers.moderation.checkImage = async (png) => {
      const prompt = promptOf.get(Buffer.from(png).toString('base64')) ?? '';
      const isP1Scene = prompt.includes('第 1 页');
      if (isP1Scene && p1Rejects-- > 0) return { verdict: 'reject', reason: 'bad pixels' };
      return { verdict: 'pass' };
    };
    createBook({ page_count: 1 });
    await pipeline.run('b1');
    expect(repo.get('b1')?.state).toBe('ready');
    const attempts = [...p1Seeds].flatMap((s) => promptsBySeed.get(s) ?? []);
    expect(attempts).toHaveLength(3);
    expect(attempts[0]).toContain('第 1 页');
    expect(attempts[1]).toContain('第 1 页');
    // 末次尝试改用软化 prompt：不含具体页场景，带「没有任何人物」安全描述
    expect(attempts[2]).not.toContain('第 1 页');
    expect(attempts[2]).toContain('没有任何人物与动物');
    expect(store.tryReadPageAssets('b1', 'p1')?.image_failed).toBeUndefined();
  });

  it('fails the stage when every page falls back to a placeholder', async () => {
    providers.image = {
      name: 'dead-image',
      generateImage: async () => {
        throw new Error('always down');
      },
    };
    createBook();
    await pipeline.run('b1');
    expect(repo.get('b1')?.state).toBe('failed_pages_generating');
    expect(repo.get('b1')?.error).toContain('always down');
  });

  it('retrying the pages stage re-attempts placeholder pages and clears the flag', async () => {
    const realImage = providers.image;
    const p2Seed = hashSeed('b1:p2') >>> 0;
    const p2Seeds = new Set([p2Seed, p2Seed + 101, p2Seed + 202]);
    let p2Down = true;
    providers.image = {
      name: 'flaky-p2',
      generateImage: async (req) => {
        if (p2Down && p2Seeds.has(req.seed)) throw new Error('p2 down');
        return realImage.generateImage(req);
      },
    };
    createBook();
    await pipeline.run('b1');
    expect(store.tryReadPageAssets('b1', 'p2')?.image_failed).toBe(true);

    // 服务恢复后从 pages 阶段重跑：占位页自动再试，标记清除
    p2Down = false;
    repo.update({ ...repo.get('b1')!, state: 'pages_generating' });
    await pipeline.run('b1');
    expect(repo.get('b1')?.state).toBe('ready');
    const p2 = store.tryReadPageAssets('b1', 'p2');
    expect(p2?.image_failed).toBeUndefined();
    expect(p2?.subject_urls.length).toBeGreaterThan(0);
  });
});

describe('Pipeline.regeneratePage', () => {
  it('rebuilds page image and clip with a new seed', async () => {
    createBook();
    await pipeline.run('b1');
    const seedBefore = store.tryReadPageAssets('b1', 'p2')?.seed;
    const clipCallsBefore = clipCalls.length;

    await pipeline.regeneratePage('b1', 'p2');

    const manifest = store.tryReadPageAssets('b1', 'p2');
    expect(manifest?.seed).not.toBe(seedBefore);
    expect(manifest?.clip_duration_ms).toBe(5000);
    expect(clipCalls.length).toBe(clipCallsBefore + 1);
    expect(repo.get('b1')?.state).toBe('ready');
    expect(repo.get('b1')?.counters.pageRegens['p2']).toBe(1);
  });

  it('rejects regen when not ready or over the limit', async () => {
    createBook();
    await expect(pipeline.regeneratePage('b1', 'p1')).rejects.toThrow(/not ready/);
    await pipeline.run('b1');
    for (let i = 0; i < 3; i++) await pipeline.regeneratePage('b1', 'p1');
    await expect(pipeline.regeneratePage('b1', 'p1')).rejects.toThrow(/limit/);
  });
});

describe('Pipeline narration (auto per-page during clip stage)', () => {
  let ttsReqs: { text: string; lang: string; voice?: string }[];

  function withTtsStub() {
    ttsReqs = [];
    providers.tts = {
      name: 'tts:stub',
      synthesize: async (req) => {
        ttsReqs.push({ text: req.text, lang: req.lang, voice: req.voice });
        // 合法的小 WAV（20ms 静音），供多段拼接路径解析
        const samples = new Int16Array(480);
        return { audio: encodeWav(samples, 24_000) };
      },
    };
    pipeline = new Pipeline(
      providers,
      repo,
      store,
      hub,
      { pageSize: size, probeDurationMs: async () => 1800, voiceReview: false },
      {
        name: 'clip:stub',
        generateClip: async (args: GenerateClipArgs) => {
          clipCalls.push(args);
          const path = clipPathFor(store, args.bookId, args.pageId);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, Buffer.from([1, 2, 3]));
          return { durationMs: 5000 };
        },
      },
    );
  }

  it('synthesizes every page narration into narration.wav during run', async () => {
    // 6 页：p3 含角色对白段（3 页时唯一的对白页恰好被核心思想页覆盖）
    createBook({ page_count: 6, progress: { pages_done: 0, pages_total: 6 } });
    withTtsStub();
    await pipeline.run('b1');

    const story = store.readStory('b1', 'zh');
    // 片头旁白先行：默认旁白音色只念大标题
    expect(ttsReqs[0]).toEqual({ text: story.cover!.title, lang: 'zh', voice: undefined });
    // 逐段合成：旁白段 voice 缺省，角色段用角色音色（Fake story 每 3 页一段对白）。
    // 旁白并发跑：跨页请求可交错，按多重集（排序后）比较
    const expected = story.pages.flatMap((p) =>
      (p.segments ?? [{ speaker: NARRATOR, text: p.narration }]).map((s) => ({
        text: s.text,
        lang: 'zh',
        voice: s.speaker === NARRATOR ? undefined : 'Mochi',
      })),
    );
    const key = (r: { text: string; voice?: string }) => `${r.voice ?? '-'}\u0000${r.text}`;
    expect([...ttsReqs.slice(1)].sort((a, b) => key(a).localeCompare(key(b)))).toEqual(
      [...expected].sort((a, b) => key(a).localeCompare(key(b))),
    );
    expect(ttsReqs.some((r) => r.voice === 'Mochi')).toBe(true);
    for (const page of [{ page_id: 'title' }, ...story.pages]) {
      expect(
        (await import('node:fs')).existsSync(join(dir, `books/b1/pages/${page.page_id}/narration.wav`)),
      ).toBe(true);
      const manifest = store.tryReadPageAssets('b1', page.page_id);
      expect(manifest?.narration_url).toBe(`/assets/books/b1/pages/${page.page_id}/narration.wav`);
      expect(manifest?.narration_duration_ms).toBe(1800);
      // 旁白不影响该页片段产物：clip 仍指向渲染好的 canvas 片段
      expect(manifest?.clip_url).toBe(`/assets/books/b1/pages/${page.page_id}/clip.mp4`);
    }
  });

  it('a failing page narration does not block the book and emits a failed event', async () => {
    createBook();
    withTtsStub();
    const realSynth = providers.tts!.synthesize.bind(providers.tts!);
    providers.tts = {
      name: 'tts:flaky',
      synthesize: async (req) => {
        if (req.text === store.readStory('b1', 'zh').pages[1]!.narration) throw new Error('tts quota');
        return realSynth(req);
      },
    };
    await pipeline.run('b1');

    expect(repo.get('b1')?.state).toBe('ready');
    expect(store.tryReadPageAssets('b1', 'p1')?.narration_url).toBeDefined();
    expect(store.tryReadPageAssets('b1', 'p2')?.narration_url).toBeUndefined();
    expect(store.tryReadPageAssets('b1', 'p3')?.narration_url).toBeDefined();
    const failed = events.find(
      (e): e is Extract<HubMessage, { type: 'page_narration' }> =>
        e.type === 'page_narration' && e.status === 'failed',
    );
    expect(failed?.page_id).toBe('p2');
    expect(failed?.error).toContain('tts quota');
  });

  it('skips narration entirely without a tts provider', async () => {
    createBook();
    delete providers.tts;
    await pipeline.run('b1');
    expect(repo.get('b1')?.state).toBe('ready');
    expect(store.tryReadPageAssets('b1', 'p1')?.narration_url).toBeUndefined();
  });

  it('does not re-synthesize existing narration on resume', async () => {
    createBook();
    withTtsStub();
    await pipeline.run('b1');
    expect(ttsReqs).toHaveLength(4); // 片头 + 3 正文页
    // 模拟从 enhance_generating 恢复：旁白已合成的页不重复合成
    repo.update({ ...repo.get('b1')!, state: 'enhance_generating' });
    await pipeline.run('b1');
    expect(ttsReqs).toHaveLength(4);
  });

  it('editPageText re-dubs and re-renders only that page, keeps illustration and invalidates export', async () => {
    createBook();
    withTtsStub();
    await pipeline.run('b1');

    const imageBefore = store.tryReadPageAssets('b1', 'p1');
    const clipCallsBefore = clipCalls.length;
    ttsReqs = [];
    repo.update({
      ...repo.get('b1')!,
      exports: { zh: { url: '/x.mp4', duration_ms: 1, size_bytes: 1 } },
    });

    await pipeline.editPageText('b1', 'p1', { narration: '全新的一句话旁白。' });

    // 只重配该页：单段旁白（角色分段被重置），文本即新文案
    expect(ttsReqs).toEqual([{ text: '全新的一句话旁白。', lang: 'zh', voice: undefined }]);
    // 只重渲该页片段（字幕烧在画面里）
    expect(clipCalls.length).toBe(clipCallsBefore + 1);
    expect(clipCalls[clipCalls.length - 1]!.pageId).toBe('p1');
    // 插画与 seed 不动
    const after = store.tryReadPageAssets('b1', 'p1');
    expect(after?.seed).toBe(imageBefore?.seed);
    expect(after?.image_url).toBe(imageBefore?.image_url);
    // story 与 spec 已更新为新文案
    expect(store.readStory('b1', 'zh').pages[0]!.narration).toBe('全新的一句话旁白。');
    const spec = BookSpecSchema.parse(
      JSON.parse((await import('node:fs')).readFileSync(join(dir, 'books/b1/book_specs/zh.json'), 'utf8')),
    ) as BookSpec;
    expect(spec.pages.find((p) => p.page_id === 'p1')!.subtitle?.text).toBe('全新的一句话旁白。');
    // 旧成片作废
    expect(repo.get('b1')!.exports).toBeUndefined();
    expect(repo.get('b1')!.state).toBe('ready');
    // 片段渲染完成发出 page_clip ready（前端据此重载预览）
    expect(
      events.some(
        (e) => e.type === 'page_clip' && e.page_id === 'p1' && e.status === 'ready',
      ),
    ).toBe(true);
  });

  it('editPageText parses 【旁白】/【角色】markup into per-speaker segments', async () => {
    createBook();
    withTtsStub();
    await pipeline.run('b1');
    ttsReqs = [];
    // fake story 主角名「小暖」：标记它 → 用角色音色；旁白 → 默认音色
    await pipeline.editPageText('b1', 'p1', {
      narration: '【旁白】夜里静悄悄的。【小暖】我不怕黑。',
    });

    const story = store.readStory('b1', 'zh');
    const page = story.pages[0]!;
    expect(page.segments).toEqual([
      { speaker: NARRATOR, text: '夜里静悄悄的。' },
      { speaker: '小暖', text: '我不怕黑。' },
    ]);
    // narration（字幕）为去标记纯文本拼接
    expect(page.narration).toBe('夜里静悄悄的。我不怕黑。');
    const byText = [...ttsReqs].sort((a, b) => a.text.localeCompare(b.text));
    expect(byText).toEqual([
      { text: '我不怕黑。', lang: 'zh', voice: 'Mochi' },
      { text: '夜里静悄悄的。', lang: 'zh', voice: undefined },
    ]);
    // spec 透传 segments 供前端编辑回填
    const spec = BookSpecSchema.parse(
      JSON.parse((await import('node:fs')).readFileSync(join(dir, 'books/b1/book_specs/zh.json'), 'utf8')),
    ) as BookSpec;
    expect(spec.pages.find((p) => p.page_id === 'p1')!.segments).toEqual(page.segments);
  });

  it('editPageText rejects unknown speakers in markup', async () => {
    createBook();
    withTtsStub();
    await pipeline.run('b1');
    await expect(
      pipeline.editPageText('b1', 'p1', { narration: '【神秘人】你是谁？' }),
    ).rejects.toThrow(/unknown_speakers:神秘人/);
    // story 未被破坏
    expect(store.readStory('b1', 'zh').pages[0]!.narration).toBeTruthy();
  });

  it('editPageText on the title page edits cover text and re-dubs the title narration', async () => {
    createBook();
    withTtsStub();
    await pipeline.run('b1');
    ttsReqs = [];

    await pipeline.editPageText('b1', 'title', { cover: { title: '新的大标题', tags: ['睡前', '治愈'] } });

    const story = store.readStory('b1', 'zh');
    expect(story.cover!.title).toBe('新的大标题');
    expect(story.cover!.tags).toEqual(['睡前', '治愈']);
    // 片头旁白只念大标题
    expect(ttsReqs).toEqual([{ text: '新的大标题', lang: 'zh', voice: undefined }]);
    const spec = BookSpecSchema.parse(
      JSON.parse((await import('node:fs')).readFileSync(join(dir, 'books/b1/book_specs/zh.json'), 'utf8')),
    ) as BookSpec;
    expect(spec.pages[0]!.title_overlay?.title).toBe('新的大标题');
  });

  it('editPageText requires a ready book and an existing page', async () => {
    createBook();
    await expect(pipeline.editPageText('b1', 'p1', { narration: 'x' })).rejects.toThrow(/not ready/);
    await pipeline.run('b1');
    await expect(pipeline.editPageText('b1', 'p9', { narration: 'x' })).rejects.toThrow(/page not found/);
  });

  it('redubNarration re-synthesizes all pages and repairs dropped narration lines', async () => {
    createBook({ page_count: 6, progress: { pages_done: 0, pages_total: 6 } });
    withTtsStub();
    await pipeline.run('b1');
    const firstRun = ttsReqs.length;
    // 篡改 story：p1 的分段丢掉旁白过渡句（模拟旧书 AI 漏段），narration 保持完整
    const story = store.readStory('b1', 'zh');
    const p1 = story.pages[0]!;
    p1.narration = `${p1.narration}（补读的旁白尾巴）`;
    p1.segments = [{ speaker: NARRATOR, text: p1.narration.slice(0, 4) }];
    store.writeStory('b1', 'zh', story);
    repo.update({ ...repo.get('b1')!, state: 'completed', exports: { zh: { url: '/x.mp4', duration_ms: 1, size_bytes: 1 } } });

    ttsReqs = [];
    await pipeline.redubNarration('b1');

    // 全部页重新合成（页数×段数 >= 首轮），且 p1 的文本覆盖完整 narration（补回丢掉的旁白）
    expect(ttsReqs.length).toBeGreaterThanOrEqual(firstRun);
    const p1Texts = story.pages[0]!.segments!.map((s) => s.text).join('');
    expect(p1Texts.length).toBeLessThan(p1.narration.length); // 篡改后分段确实缺字
    const p1Synth = ttsReqs.filter((r) => r.text.includes('（补读的旁白尾巴）'));
    expect(p1Synth.length).toBe(1); // redub 用 repairSegments 补回了尾巴
    // 旧成片作废：回到 ready 且 exports 清空，可重新导出
    const rec = repo.get('b1')!;
    expect(rec.state).toBe('ready');
    expect(rec.exports).toBeUndefined();
    expect(store.tryReadPageAssets('b1', 'p1')?.narration_url).toBeDefined();
  });
});
