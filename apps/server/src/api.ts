import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Lang, ProjectProviders } from '@pb/ai-core';
import {
  createRealProjectProviders,
  createRealProviders,
  loadRealProvidersConfig,
  VOICE_PALETTE,
  type ProviderBundle,
} from '@pb/ai-core';
import { AssetStore } from './asset-store';
import { BookRepo, type ExportArtifact } from './book-repo';
import { EventHub, type ProjectHubMessage } from './events';
import { ExportJob } from './export/export-job';
import { HarnessDriver } from './export/harness-driver';
import { ConcatExporter } from './export/concat-exporter';
import { ProjectExporter } from './export/project-exporter';
import { HeadlessClipRenderer, type ClipSource } from './export/clip-source';
import { Pipeline } from './pipeline';
import { SerialQueue } from './queue';
import { initialCounters, MAX_PAGE_REGENS, transition } from './state-machine';
import { ProjectRepo } from './project-repo';
import { ScriptPipeline } from './script-pipeline';
import { registerProjectsApi } from './projects-api';

export interface AppConfig {
  dataDir: string;
  /** 供应商注入点（测试用桩）；生产默认按 env 构建真实供应商 */
  providers?: ProviderBundle;
  /** 故事视频产线供应商注入点（测试用桩） */
  projectProviders?: ProjectProviders;
  pageSize?: { width: number; height: number };
  exporter?: { exportBook(bookId: string, lang: Lang): Promise<ExportArtifact> };
  /** 故事视频产线导出器注入点（测试用桩） */
  projectExporter?: { exportProject(projectId: string): Promise<ExportArtifact> };
  exportFps?: number;
  /** 幕间交叉溶解时长（ms）；0 关闭转场（默认 600，见 ConcatExporter） */
  exportTransitionMs?: number;
  /** 背景音乐路径；'off' 关闭，缺省用内置卡农钢琴版 */
  bgm?: string;
  /** 环境音效层（雨/风等从每页氛围派生）；'off' 关闭，缺省开启 */
  sfx?: string;
  clipSource?: ClipSource;
  /** API 服务对外源（headless 渲染时 harness 据此拉取资产） */
  assetOrigin?: string;
  /** 强制页数（env PB_DEFAULT_PAGE_COUNT，主要供 e2e 注入确定页数）；缺省由 AI 按故事节奏自行分幕 */
  defaultPageCount?: number;
  /** 读取环境变量的来源（默认 process.env） */
  env?: Record<string, string | undefined>;
  /** AI 片段时长探测（默认 ffprobe）；测试可注入桩 */
  probeDurationMs?: (path: string) => Promise<number>;
  /** 音色确认暂停点：缺省开启（故事定稿后停在 voice_review）；false 自动放行（测试/批量） */
  voiceReview?: boolean;
}

const CreateBookBody = z.object({
  theme: z.string().min(1).max(10000),
  /** 用户主动输入的书名（可选）：定稿后覆盖 AI 生成的书名与片头大标题 */
  title: z.string().min(1).max(50).optional(),
  style: z
    .enum(['watercolor', 'flat', 'cartoon', 'crayon', 'anime', 'chibi', 'ghibli', 'colored-pencil', 'collage', 'gouache'])
    .default('watercolor'),
  lang: z.enum(['zh', 'en']).default('zh'),
  /** 画幅：横版 16:9（默认）/ 竖版 9:16（短视频平台） */
  format: z.enum(['landscape', 'portrait']).default('landscape'),
  page_count: z.number().int().min(3).max(30).optional(),
  enhance: z.boolean().default(false),
  /** 背景音乐开关：false=成片不混 BGM（缺省开启，按全局 PB_BGM 配置） */
  bgm: z.boolean().default(true),
});

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const assets = new AssetStore(config.dataDir);
  const repo = new BookRepo(assets);
  const hub = new EventHub();
  const queue = new SerialQueue();
  // 演示模式已移除：生产启动无条件构建真实供应商（缺 key 启动即抛 MissingEnvError）；
  // 测试通过 config.providers 注入 Fake 桩。
  const providers = config.providers ?? createRealProviders(loadRealProvidersConfig(config.env ?? process.env));
  // 默认片段来源：插画 → PixiJS headless 逐帧渲染（canvas 动画）；
  // 用户可在预览页逐页点击「AI 生成视频」改用图生视频片段。
  const clipSource =
    config.clipSource ??
    new HeadlessClipRenderer({
      assets,
      driver: new HarnessDriver(),
      fps: config.exportFps ?? 30,
      assetOrigin: config.assetOrigin ?? 'http://127.0.0.1:8787',
    });
  const pipeline = new Pipeline(providers, repo, assets, hub, {
    pageSize: config.pageSize ?? { width: 1920, height: 1080 },
    probeDurationMs: config.probeDurationMs,
    voiceReview: config.voiceReview,
  }, clipSource);
  const exporter = config.exporter ?? new ConcatExporter({
    assets,
    fps: config.exportFps,
    transitionMs: config.exportTransitionMs,
    bgmPath: config.bgm === 'off' ? null : config.bgm,
    sfx: config.sfx !== 'off',
  });
  const exportJob = new ExportJob({ repo, hub, exporter, assets });

  // ---------- 故事视频产线（projects）：独立供应商集合、独立队列，i2v 慢任务不堵绘本队列 ----------
  let projectProviders = config.projectProviders;
  if (!projectProviders && config.providers === undefined) {
    // 生产启动：与绘本共用 env 配置（缺 key 时 loadRealProvidersConfig 已在上游抛错）
    projectProviders = createRealProjectProviders(loadRealProvidersConfig(config.env ?? process.env));
  }
  if (projectProviders) {
    const projectRepo = new ProjectRepo(assets);
    const projectHub = new EventHub<ProjectHubMessage>();
    const projectQueue = new SerialQueue();
    const scriptPipeline = new ScriptPipeline(projectProviders, projectRepo, assets, projectHub, {
      pageSize: config.pageSize ?? { width: 1920, height: 1080 },
      probeDurationMs: config.probeDurationMs,
    });
    const projectExporter =
      config.projectExporter ??
      new ProjectExporter({
        assets,
        repo: projectRepo,
        pageSize: config.pageSize,
        fps: config.exportFps,
        transitionMs: config.exportTransitionMs,
        bgmPath: config.bgm === 'off' ? null : config.bgm,
        sfx: config.sfx !== 'off',
        probeDurationMs: config.probeDurationMs,
      });
    registerProjectsApi({
      app,
      providers: projectProviders,
      repo: projectRepo,
      assets,
      hub: projectHub,
      pipeline: scriptPipeline,
      queue: projectQueue,
      exporter: projectExporter,
    });
  }

  await app.register(fastifyStatic, { root: config.dataDir, prefix: '/assets/' });
  // 导出 worker 的 harness 页面从另一个源（vite）拉取 /assets，需要 CORS
  await app.register(cors, { origin: true });

  app.post('/api/books', async (req, reply) => {
    const parsed = CreateBookBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', reason: parsed.error.message });
    }
    const body = parsed.data;
    const mod = await providers.moderation.checkText(body.title ? `${body.theme}\n${body.title}` : body.theme);
    if (mod.verdict === 'reject') {
      return reply.code(400).send({ error: 'input_rejected', reason: mod.reason ?? 'rejected' });
    }
    const id = randomUUID();
    const now = Date.now();
    const pageCount = body.page_count ?? config.defaultPageCount;
    repo.create({
      id,
      theme: body.theme,
      title: body.title,
      style: body.style,
      format: body.format,
      langs: [body.lang],
      enhance: body.enhance,
      bgm: body.bgm,
      page_count: pageCount,
      state: 'created',
      counters: initialCounters(),
      progress: { pages_done: 0, pages_total: pageCount ?? 0 },
      created_at: now,
      updated_at: now,
    });
    void queue.enqueue(() => pipeline.run(id));
    return reply.code(201).send({ book_id: id });
  });

  app.get('/api/books/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = repo.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    const body: Record<string, unknown> = {
      book_id: record.id,
      state: record.state,
      progress: record.progress,
    };
    if (record.error) body.error = record.error;
    if (record.exports) body.exports = record.exports;
    // 音色确认暂停点：把角色列表直接放进状态响应，前端无需额外拉取
    if (record.state === 'voice_review') {
      try {
        const story = assets.readStory(id, record.langs[0]!);
        body.voice_review = {
          characters: story.characters.map((c) => ({
            name: c.name,
            appearance_desc: c.appearance_desc,
            voice: c.voice ?? null,
          })),
          narrator_voice: story.narrator_voice ?? null,
        };
      } catch {
        // story 缺失时不阻塞状态接口
      }
    }
    if (record.state === 'ready' || record.state === 'exporting' || record.state === 'completed') {
      body.preview = {
        book_specs: Object.fromEntries(record.langs.map((l) => [l, assets.bookSpecUrl(id, l)])),
      };
      try {
        const story = assets.readStory(id, record.langs[0]!);
        body.clips = story.pages.map((p) => {
          const m = assets.tryReadPageAssets(id, p.page_id);
          return {
            page_id: p.page_id,
            narration_url: m?.narration_url,
            image_failed: !!m?.image_failed,
          };
        });
      } catch {
        // story 缺失时不阻塞状态接口
      }
    }
    return body;
  });

  app.get('/api/books/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = repo.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (payload: unknown) => raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({ bookId: id, type: 'state', state: record.state });
    send({ bookId: id, type: 'progress', progress: record.progress });
    if (record.state === 'ready') send({ bookId: id, type: 'completed' });
    const unsubscribe = hub.subscribe(id, send);
    req.raw.on('close', () => {
      unsubscribe();
    });
  });

  app.post('/api/books/:id/pages/:pageId/regenerate', async (req, reply) => {
    const { id, pageId } = req.params as { id: string; pageId: string };
    const record = repo.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    if (record.state !== 'ready') return reply.code(409).send({ error: 'not_ready' });
    const used = record.counters.pageRegens[pageId] ?? 0;
    if (used >= MAX_PAGE_REGENS) return reply.code(409).send({ error: 'regen_limit' });
    void queue.enqueue(() => pipeline.regeneratePage(id, pageId));
    return reply.code(202).send({ remaining: MAX_PAGE_REGENS - used - 1 });
  });

  const ExportBody = z.object({
    langs: z.array(z.enum(['zh', 'en'])).min(1).optional(),
  });

  const PageTextBody = z.object({
    /** 正文页：新的旁白文本（字幕与语音同源） */
    narration: z.string().min(1).max(200).optional(),
    /** 片头幕：封面标题/副标题/标签 */
    cover: z
      .object({
        title: z.string().min(1).max(30).optional(),
        subtitle: z.string().max(40).optional(),
        tags: z.array(z.string().min(1).max(12)).max(6).optional(),
      })
      .optional(),
  });

  // 文案编辑：改旁白/片头标题后重配该页语音并重渲染该页片段（不重画插画）。
  // 新文本先过文本审核（快速同步），重配/重渲入队异步执行，进度经 SSE 通知。
  app.put('/api/books/:id/pages/:pageId/text', async (req, reply) => {
    const { id, pageId } = req.params as { id: string; pageId: string };
    const record = repo.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    if (record.state !== 'ready') return reply.code(409).send({ error: 'not_ready' });
    const parsed = PageTextBody.safeParse(req.body);
    if (!parsed.success || (!parsed.data.narration && !parsed.data.cover)) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const { narration, cover } = parsed.data;
    const draft = [narration, cover?.title, cover?.subtitle, ...(cover?.tags ?? [])]
      .filter(Boolean)
      .join('\n');
    if (!draft) return reply.code(400).send({ error: 'invalid_body' });
    const mod = await providers.moderation.checkText(draft);
    if (mod.verdict === 'reject') {
      return reply.code(400).send({ error: 'input_rejected', reason: mod.reason ?? 'rejected' });
    }
    void queue.enqueue(() => pipeline.editPageText(id, pageId, { narration, cover }).catch(() => undefined));
    return reply.code(202).send({ state: 'editing' });
  });

  // 重新配音：按（修复后的）分段逐页重合成旁白，不重渲染插画/片段
  app.post('/api/books/:id/redub', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = repo.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    if (record.state !== 'ready' && record.state !== 'completed')
      return reply.code(409).send({ error: 'not_ready' });
    if (!providers.tts) return reply.code(409).send({ error: 'tts_unavailable' });
    void queue.enqueue(() => pipeline.redubNarration(id).catch(() => undefined));
    return reply.code(202).send({ state: 'redubbing' });
  });

  app.post('/api/books/:id/export', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = repo.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    if (record.state !== 'ready') return reply.code(409).send({ error: 'not_ready' });
    const parsed = ExportBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const langs = parsed.data.langs ?? record.langs;
    void queue.enqueue(() => exportJob.run(id, langs));
    return reply.code(202).send({ state: 'exporting' });
  });

  // ---------- 音色确认（voice_review 暂停点） ----------
  // 故事定稿后产线停在 voice_review：前端拉角色列表、试听、改配音色，
  // 再 confirm 推进到插画/配音阶段。

  const CharacterVoicesBody = z.object({
    /** 角色名 → 音色 id（VOICE_PALETTE 键）；null/缺省=回退默认旁白音色 */
    voices: z.record(z.string(), z.string().nullable()).default({}),
  });

  app.get('/api/books/:id/characters', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = repo.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    if (record.state !== 'voice_review') return reply.code(409).send({ error: 'not_in_voice_review' });
    try {
      const story = assets.readStory(id, record.langs[0]!);
      return {
        characters: story.characters.map((c) => ({ name: c.name, appearance_desc: c.appearance_desc, voice: c.voice ?? null })),
        narrator_voice: story.narrator_voice ?? null,
        voices: VOICE_PALETTE,
      };
    } catch {
      return reply.code(409).send({ error: 'story_not_ready' });
    }
  });

  app.put('/api/books/:id/characters', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = repo.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    if (record.state !== 'voice_review') return reply.code(409).send({ error: 'not_in_voice_review' });
    const parsed = CharacterVoicesBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', reason: parsed.error.message });
    const voices: Record<string, string | undefined> = {};
    for (const [name, voice] of Object.entries(parsed.data.voices)) {
      voices[name] = voice ?? undefined;
    }
    try {
      pipeline.setCharacterVoices(id, voices);
    } catch (err) {
      return reply.code(409).send({ error: 'set_voices_failed', reason: err instanceof Error ? err.message : String(err) });
    }
    return { ok: true };
  });

  app.post('/api/books/:id/confirm-voices', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = repo.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    if (record.state !== 'voice_review') return reply.code(409).send({ error: 'not_in_voice_review' });
    try {
      pipeline.confirmVoices(id);
    } catch (err) {
      return reply.code(409).send({ error: 'confirm_failed', reason: err instanceof Error ? err.message : String(err) });
    }
    void queue.enqueue(() => pipeline.run(id));
    return reply.code(202).send({ state: 'pages_generating' });
  });

  app.post('/api/books/:id/resume', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = repo.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    const result = transition(record.state, { type: 'RESUME' }, record.counters, {
      enhance: record.enhance,
    });
    if (!result.ok) return reply.code(409).send({ error: 'not_failed' });
    repo.update({
      ...record,
      state: result.state,
      counters: result.counters,
      error: undefined,
      updated_at: Date.now(),
    });
    void queue.enqueue(() => pipeline.run(id));
    return reply.code(202).send({ state: result.state });
  });

  return app;
}
