import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProjectProviders, ScriptAnalysis } from '@pb/ai-core';
import type { AssetStore } from './asset-store';
import type { EventHub, ProjectHubMessage } from './events';
import type { ProjectRepo, ScriptProjectRecord } from './project-repo';
import type { ExportArtifact } from './book-repo';
import {
  initialProjectCounters,
  MAX_LOCATION_REGENS,
  MAX_PORTRAIT_REGENS,
  transitionProject,
} from './project-state-machine';
import type { ScriptPipeline } from './script-pipeline';
import type { SerialQueue } from './queue';

export interface ProjectsApiDeps {
  app: FastifyInstance;
  providers: ProjectProviders;
  repo: ProjectRepo;
  assets: AssetStore;
  hub: EventHub<ProjectHubMessage>;
  pipeline: ScriptPipeline;
  /** 独立队列：r2v 慢任务不堵绘本产线 */
  queue: SerialQueue;
  /** 成片导出器（复用 joinClips 公共核） */
  exporter: { exportProject(projectId: string): Promise<ExportArtifact> };
}

const CreateProjectBody = z.object({
  /** 主题或整篇文章原文 */
  source: z.string().min(1).max(10000),
  /** 用户指定作品名（可选，定稿后强制覆盖 AI 标题） */
  title: z.string().min(1).max(50).optional(),
  /** 视频风格预设（故事视频产线专用，与绘本画风独立） */
  style: z
    .enum(['realistic-3d', 'anime', 'fantasy-picturebook', 'inkwash'])
    .default('anime'),
  format: z.enum(['landscape', 'portrait']).default('landscape'),
  lang: z.enum(['zh', 'en']).default('zh'),
  episode_count: z.number().int().min(1).max(3).optional(),
});

const SelectBody = z.object({ seed: z.number().int() });

const RegenerateBody = z.object({
  appearance: z.string().min(1).max(300).optional(),
  costume: z.string().max(200).optional(),
});

const RegenerateLocationBody = z.object({
  description: z.string().min(1).max(500).optional(),
});

/** 项目对外视图（GET /api/projects/:id 与 SSE 初始帧共用）；script 为剧本原文，供分镜工作台展示脚本内容 */
function projectView(
  record: ScriptProjectRecord,
  script?: ScriptAnalysis,
): Record<string, unknown> {
  return {
    project_id: record.id,
    title: record.title,
    style: record.style,
    format: record.format,
    lang: record.lang,
    state: record.state,
    progress: record.progress,
    error: record.error,
    characters: record.characters,
    locations: record.locations,
    scenes: record.scenes,
    export: record.export,
    script,
  };
}

export function registerProjectsApi(deps: ProjectsApiDeps): void {
  const { app, providers, repo, assets, hub, pipeline, queue, exporter } = deps;

  /** 导出任务：ready→exporting→completed，失败回 ready（同绘本 ExportJob 语义） */
  const runExport = async (id: string): Promise<void> => {
    const start = repo.get(id)!;
    const begin = transitionProject(start.state, { type: 'START_EXPORT' }, start.counters);
    if (!begin.ok) return;
    repo.update({ ...start, state: begin.state, updated_at: Date.now() });
    hub.publish(id, { projectId: id, type: 'state', state: begin.state });
    try {
      const artifact = await exporter.exportProject(id);
      const cur = repo.get(id)!;
      const done = transitionProject(cur.state, { type: 'EXPORT_DONE' }, cur.counters);
      if (!done.ok) throw new Error(done.error);
      repo.update({ ...cur, state: done.state, export: artifact, updated_at: Date.now() });
      hub.publish(id, { projectId: id, type: 'state', state: done.state });
      hub.publish(id, { projectId: id, type: 'completed' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cur = repo.get(id)!;
      const fail = transitionProject(cur.state, { type: 'EXPORT_FAILED', error: message }, cur.counters);
      if (fail.ok) {
        repo.update({ ...cur, state: fail.state, error: message, updated_at: Date.now() });
        hub.publish(id, { projectId: id, type: 'state', state: fail.state });
      }
      hub.publish(id, { projectId: id, type: 'failed', error: message });
    }
  };

  app.post('/api/projects', async (req, reply) => {
    const parsed = CreateProjectBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', reason: parsed.error.message });
    }
    const body = parsed.data;
    const mod = await providers.moderation.checkText(
      body.title ? `${body.source}\n${body.title}` : body.source,
    );
    if (mod.verdict === 'reject') {
      return reply.code(400).send({ error: 'input_rejected', reason: mod.reason ?? 'rejected' });
    }
    const id = randomUUID();
    const now = Date.now();
    repo.create({
      id,
      source: body.source,
      title: body.title,
      style: body.style,
      format: body.format,
      lang: body.lang,
      episode_count: body.episode_count,
      state: 'created',
      counters: initialProjectCounters(),
      progress: { units_done: 0, units_total: 0 },
      characters: [],
      locations: [],
      scenes: [],
      created_at: now,
      updated_at: now,
    });
    void queue.enqueue(() => pipeline.run(id));
    return reply.code(201).send({ project_id: id });
  });

  app.get('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = repo.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    const view = projectView(record, assets.tryReadScript(id));
    view.capabilities = { ai_video: !!providers.videoClip };
    return view;
  });

  app.get('/api/projects/:id/events', async (req, reply) => {
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
    send({ projectId: id, type: 'state', state: record.state });
    send({ projectId: id, type: 'progress', progress: record.progress });
    const unsubscribe = hub.subscribe(id, send);
    req.raw.on('close', () => {
      unsubscribe();
    });
  });

  // 卡点：选定某角色某版立绘
  app.put('/api/projects/:id/characters/:charId/select', async (req, reply) => {
    const { id, charId } = req.params as { id: string; charId: string };
    const record = repo.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    if (record.state !== 'awaiting_character_confirmation') {
      return reply.code(409).send({ error: 'not_awaiting_confirmation' });
    }
    const parsed = SelectBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    try {
      const updated = pipeline.selectPortrait(id, charId, parsed.data.seed);
      return projectView(updated);
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 卡点：改描述重出 3 版（先审核描述），或同描述换 seed 重抽
  app.post('/api/projects/:id/characters/:charId/regenerate', async (req, reply) => {
    const { id, charId } = req.params as { id: string; charId: string };
    const record = repo.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    if (record.state !== 'awaiting_character_confirmation') {
      return reply.code(409).send({ error: 'not_awaiting_confirmation' });
    }
    const parsed = RegenerateBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const used = record.counters.portraitRegens[charId] ?? 0;
    if (used >= MAX_PORTRAIT_REGENS) return reply.code(409).send({ error: 'regen_limit' });
    try {
      await pipeline.regeneratePortrait(id, charId, {
        appearance: parsed.data.appearance,
        costume: parsed.data.costume,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('rejected')) return reply.code(400).send({ error: 'input_rejected', reason: msg });
      if (msg.includes('limit')) return reply.code(409).send({ error: 'regen_limit' });
      return reply.code(409).send({ error: msg });
    }
    return reply.code(202).send({
      remaining: MAX_PORTRAIT_REGENS - used - 1,
      characters: repo.get(id)!.characters,
    });
  });

  // 卡点：选定某地点某版场景图
  app.put('/api/projects/:id/locations/:locId/select', async (req, reply) => {
    const { id, locId } = req.params as { id: string; locId: string };
    const record = repo.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    if (record.state !== 'awaiting_character_confirmation') {
      return reply.code(409).send({ error: 'not_awaiting_confirmation' });
    }
    const parsed = SelectBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    try {
      const updated = pipeline.selectLocation(id, locId, parsed.data.seed);
      return projectView(updated);
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 卡点：改场景描述重出 3 版（先审核描述），或同描述换 seed 重抽
  app.post('/api/projects/:id/locations/:locId/regenerate', async (req, reply) => {
    const { id, locId } = req.params as { id: string; locId: string };
    const record = repo.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    if (record.state !== 'awaiting_character_confirmation') {
      return reply.code(409).send({ error: 'not_awaiting_confirmation' });
    }
    const parsed = RegenerateLocationBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const used = record.counters.locationRegens[locId] ?? 0;
    if (used >= MAX_LOCATION_REGENS) return reply.code(409).send({ error: 'regen_limit' });
    try {
      await pipeline.regenerateLocation(id, locId, parsed.data.description);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('rejected')) return reply.code(400).send({ error: 'input_rejected', reason: msg });
      if (msg.includes('limit')) return reply.code(409).send({ error: 'regen_limit' });
      return reply.code(409).send({ error: msg });
    }
    return reply.code(202).send({
      remaining: MAX_LOCATION_REGENS - used - 1,
      locations: repo.get(id)!.locations,
    });
  });

  // 卡点放行：角色与场景全部选定 → 进入分镜工作台（此后逐场手动生成，不再自动跑）
  app.post('/api/projects/:id/characters/confirm', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = repo.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    if (record.state !== 'awaiting_character_confirmation') {
      return reply.code(409).send({ error: 'not_awaiting_confirmation' });
    }
    try {
      const updated = pipeline.confirmCharacters(id);
      return reply.code(202).send(projectView(updated));
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/projects/:id/resume', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = repo.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    if (!record.state.startsWith('failed_')) return reply.code(409).send({ error: 'not_failed' });
    // RESUME 由 pipeline.apply 走状态机；先清 error
    repo.update({ ...record, error: undefined });
    void queue.enqueue(() => pipeline.resume(id));
    return reply.code(202).send({ state: record.state.slice('failed_'.length) });
  });

  // 成片导出：全 AI 片段拼接 + 配音/BGM 混音（joinClips 公共核）
  app.post('/api/projects/:id/export', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = repo.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    if (record.state !== 'ready') return reply.code(409).send({ error: 'not_ready' });
    void queue.enqueue(() => runExport(id));
    return reply.code(202).send({ state: 'exporting' });
  });

  /** 逐场手动生成：工作台 / ready / completed 三态可触发 */
  const sceneActionable = (state: string): boolean =>
    state === 'storyboard_review' || state === 'ready' || state === 'completed';

  // 单场视频片段：r2v 参考图（选定场景图+角色立绘）直出 + 自动补配音；全部齐备自动进 ready
  app.post('/api/projects/:id/scenes/:sceneId/clip', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const record = repo.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    if (!sceneActionable(record.state)) return reply.code(409).send({ error: 'not_in_storyboard' });
    const manifest = record.scenes.find((m) => m.scene_id === sceneId);
    if (!manifest) return reply.code(404).send({ error: 'scene_not_found' });
    void queue.enqueue(() => pipeline.generateSceneClip(id, sceneId).catch(() => undefined));
    return reply.code(202).send({ scene_id: sceneId, unit: 'clip' });
  });

  // 单场重画：换 seed 重跑该场 r2v（保留配音），无次数限制
  app.post('/api/projects/:id/scenes/:sceneId/regenerate', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const record = repo.get(id);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    if (!sceneActionable(record.state)) return reply.code(409).send({ error: 'not_in_storyboard' });
    if (!record.scenes.some((m) => m.scene_id === sceneId)) {
      return reply.code(404).send({ error: 'scene_not_found' });
    }
    void queue.enqueue(() => pipeline.regenerateScene(id, sceneId).catch(() => undefined));
    return reply.code(202).send({ scene_id: sceneId });
  });
}
