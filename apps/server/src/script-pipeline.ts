import { readFileSync } from 'node:fs';
import type { ScriptAnalysis, ScriptScene, ProjectProviders } from '@pb/ai-core';
import { concatWavs, hashSeed, NARRATOR, normalizeVoice } from '@pb/ai-core';
import type { AssetStore } from './asset-store';
import type { CharacterCard, LocationCard, SceneManifest, ScriptProjectRecord } from './project-repo';
import type { ProjectRepo } from './project-repo';
import type { EventHub, ProjectHubMessage } from './events';
import type { ProjectEvent, ProjectGenerationStage } from './project-state-machine';
import { MAX_LOCATION_REGENS, MAX_PORTRAIT_REGENS, transitionProject } from './project-state-machine';
import {
  buildLocationPrompt,
  buildPortraitPrompt,
  buildR2vRequest,
  estimateClipDurationSec,
  R2V_MAX_REFS,
  sceneCast,
  selectR2vCast,
  type CastReference,
} from './script-assembly';
import { probeDurationMs } from './export/ffmpeg';
import { PORTRAIT_SIZE } from './pipeline';

export interface ScriptPipelineConfig {
  pageSize: { width: number; height: number };
  /** AI 片段时长探测（默认 ffprobe）；测试可注入桩 */
  probeDurationMs?: (path: string) => Promise<number>;
}

/** 每个角色/场景一轮出的版本数（供用户三选一） */
export const PORTRAIT_VERSIONS = 3;

/** 立绘/场景图生成的并发上限（资产之间互不依赖） */
export const PORTRAIT_CONCURRENCY = 3;

/** 单版图片生成+审核的重试次数 */
const IMAGE_MODERATION_ATTEMPTS = 2;

/** 剧本全文（送文本审核）：标题 + 角色卡 + 每场梗概/台词/旁白 */
export function scriptFullText(script: ScriptAnalysis): string {
  const chars = script.characters.map((c) => `${c.name}：${c.appearance} ${c.personality}`);
  const scenes = script.episodes.flatMap((e) =>
    e.scenes.map((s) =>
      [s.synopsis, s.narration ?? '', ...s.dialogues.map((d) => `${d.speaker}：${d.line}`)].join('\n'),
    ),
  );
  return [script.title, script.logline ?? '', ...chars, ...scenes].join('\n');
}

/** 剧本 → 角色卡初始化（保留旧卡已生成的 versions/selected，按 id 对齐） */
export function initCharacterCards(
  script: ScriptAnalysis,
  previous: CharacterCard[],
): CharacterCard[] {
  return script.characters.map((c) => {
    const old = previous.find((p) => p.id === c.id);
    return {
      id: c.id,
      name: c.name,
      appearance: old?.appearance ?? c.appearance,
      costume: old?.costume ?? c.costume,
      personality: c.personality,
      voice: normalizeVoice(c.voice),
      versions: old?.versions ?? [],
      selected: old?.selected,
    };
  });
}

/** 剧本 → 场景卡初始化（同样按 id 保留旧卡 versions/selected） */
export function initLocationCards(
  script: ScriptAnalysis,
  previous: LocationCard[],
): LocationCard[] {
  return script.locations.map((l) => {
    const old = previous.find((p) => p.id === l.id);
    return {
      id: l.id,
      name: l.name,
      description: old?.description ?? l.description,
      versions: old?.versions ?? [],
      selected: old?.selected,
    };
  });
}

export class ScriptPipeline {
  constructor(
    private readonly providers: ProjectProviders,
    private readonly repo: ProjectRepo,
    private readonly assets: AssetStore,
    private readonly hub: EventHub<ProjectHubMessage>,
    private readonly config: ScriptPipelineConfig,
  ) {}

  private apply(projectId: string, event: ProjectEvent): ScriptProjectRecord {
    const record = this.repo.get(projectId);
    if (!record) throw new Error(`project not found: ${projectId}`);
    const result = transitionProject(record.state, event, record.counters);
    if (!result.ok) throw new Error(result.error);
    const updated: ScriptProjectRecord = {
      ...record,
      state: result.state,
      counters: result.counters,
      updated_at: Date.now(),
    };
    if (event.type === 'STAGE_FAILED') updated.error = event.error;
    if (result.state === 'ready') updated.error = undefined;
    this.repo.update(updated);
    this.hub.publish(projectId, { projectId, type: 'state', state: result.state });
    if (result.state.startsWith('failed_')) {
      this.hub.publish(projectId, {
        projectId,
        type: 'failed',
        error: updated.error ?? result.state,
      });
    }
    return updated;
  }

  private publishProgress(projectId: string, done: number, total: number): void {
    this.repo.update({
      ...this.repo.get(projectId)!,
      progress: { units_done: done, units_total: total },
    });
    this.hub.publish(projectId, {
      projectId,
      type: 'progress',
      progress: { units_done: done, units_total: total },
    });
  }

  /**
   * 按当前状态驱动管线；遇 awaiting_character_confirmation 卡点自然返回，
   * 由用户确认角色与场景资产后进入 storyboard_review 分镜工作台——此后
   * 每场视频全部由用户逐场手动触发（generateSceneClip，r2v 参考图直出），
   * 不再有自动批量阶段。
   */
  async run(projectId: string): Promise<void> {
    let record = this.repo.get(projectId);
    if (!record) throw new Error(`project not found: ${projectId}`);

    if (record.state === 'created') {
      record = this.apply(projectId, { type: 'START' });
    }
    if (record.state === 'script_analyzing' || record.state === 'script_moderating') {
      const ok = await this.runScriptAndModeration(projectId);
      if (!ok) return;
      record = this.repo.get(projectId)!;
    }
    if (record.state === 'portraits_generating') {
      const ok = await this.runStageWithRetry(projectId, 'portraits_generating', () =>
        this.generatePortraits(projectId),
      );
      if (!ok) return;
      record = this.apply(projectId, { type: 'STAGE_DONE' }); // → awaiting（卡点）
    }
    if (record.state === 'awaiting_character_confirmation') return;
    if (record.state === 'ready') {
      this.hub.publish(projectId, { projectId, type: 'completed' });
    }
  }

  /** 失败恢复：failed_<stage> → 该阶段，然后继续驱动 */
  async resume(projectId: string): Promise<void> {
    const record = this.repo.get(projectId);
    if (!record) throw new Error(`project not found: ${projectId}`);
    if (record.state.startsWith('failed_')) {
      this.apply(projectId, { type: 'RESUME' });
    }
    await this.run(projectId);
  }

  private async runStageWithRetry(
    projectId: string,
    stage: ProjectGenerationStage,
    fn: () => Promise<void>,
  ): Promise<boolean> {
    for (;;) {
      try {
        await fn();
        return true;
      } catch (err) {
        const after = this.apply(projectId, {
          type: 'STAGE_FAILED',
          error: err instanceof Error ? err.message : String(err),
        });
        if (after.state === `failed_${stage}`) return false;
      }
    }
  }

  private async runScriptAndModeration(projectId: string): Promise<boolean> {
    let record = this.repo.get(projectId)!;
    if (record.state === 'script_analyzing') {
      if (!(await this.runStageWithRetry(projectId, 'script_analyzing', () => this.analyzeScript(projectId)))) {
        return false;
      }
      record = this.apply(projectId, { type: 'STAGE_DONE' });
    }
    for (;;) {
      let verdict: { passed: boolean; reason?: string };
      try {
        verdict = await this.moderateScript(projectId);
      } catch (err) {
        const after = this.apply(projectId, {
          type: 'STAGE_FAILED',
          error: err instanceof Error ? err.message : String(err),
        });
        if (after.state === 'failed_script_moderating') return false;
        continue;
      }
      if (verdict.passed) {
        this.apply(projectId, { type: 'STAGE_DONE' });
        return true;
      }
      this.repo.update({ ...this.repo.get(projectId)!, last_reject_reason: verdict.reason });
      const after = this.apply(projectId, { type: 'TEXT_REJECTED', reason: verdict.reason ?? 'rejected' });
      if (after.state === 'failed_script_moderating') return false;
      if (!(await this.runStageWithRetry(projectId, 'script_analyzing', () => this.analyzeScript(projectId)))) {
        return false;
      }
      this.apply(projectId, { type: 'STAGE_DONE' });
    }
  }

  private async analyzeScript(projectId: string): Promise<void> {
    const record = this.repo.get(projectId)!;
    let script = await this.providers.script.analyzeScript({
      source: record.source,
      title: record.title,
      style: record.style,
      lang: record.lang,
      format: record.format,
      episode_count: record.episode_count,
      reject_reason: record.last_reject_reason,
    });
    // 用户指定作品名：不依赖 AI 是否听话，强制覆盖
    if (record.title) script = { ...script, title: record.title };
    this.assets.writeScript(projectId, script);
    const characters = initCharacterCards(script, record.characters);
    const locations = initLocationCards(script, record.locations);
    this.repo.update({
      ...this.repo.get(projectId)!,
      characters,
      locations,
      progress: { units_done: 0, units_total: (characters.length + locations.length) * PORTRAIT_VERSIONS },
    });
  }

  private async moderateScript(projectId: string): Promise<{ passed: boolean; reason?: string }> {
    const script = this.assets.readScript(projectId);
    const result = await this.providers.moderation.checkText(scriptFullText(script));
    if (result.verdict === 'reject') {
      return { passed: false, reason: result.reason ?? 'rejected' };
    }
    return { passed: true };
  }

  /**
   * 资产定制：每角色 PORTRAIT_VERSIONS 版立绘 + 每地点 PORTRAIT_VERSIONS 版场景图
   * （同 prompt 不同 seed），逐版过审落盘；单版失败标 failed 不阻塞，
   * 角色与场景全部无一成功才阶段失败。幂等：已有完整一轮版本的卡跳过（恢复重跑不重复出图）。
   */
  private async generatePortraits(projectId: string): Promise<void> {
    const record = this.repo.get(projectId)!;
    const script = this.assets.readScript(projectId);
    const styleAnchor = script.style_anchor;
    const portraitSize = { width: 1024, height: 1024 };
    const locationSize = this.projectPageSize(record);

    let done = 0;
    let successCount = 0;
    let firstError: string | undefined;
    const total = (record.characters.length + record.locations.length) * PORTRAIT_VERSIONS;

    const bump = (n: number): void => {
      done += n;
      this.publishProgress(projectId, Math.min(done, total), total);
    };

    const genCharacter = async (card: CharacterCard): Promise<void> => {
      if (card.versions.filter((v) => v.url).length >= PORTRAIT_VERSIONS) {
        successCount += card.versions.filter((v) => v.url).length;
        bump(PORTRAIT_VERSIONS);
        return;
      }
      const prompt = buildPortraitPrompt(styleAnchor, card);
      const baseSeed = hashSeed(`${projectId}:${card.id}:${card.appearance}`) >>> 0;
      const versions = await this.generateImageVariants(projectId, {
        prompt,
        baseSeed,
        size: portraitSize,
        sse: (status, error) =>
          this.hub.publish(projectId, { projectId, type: 'portrait', char_id: card.id, status, error }),
        write: (rel, png) => this.assets.writeCharacterBinary(projectId, card.id, rel, png),
        url: (rel) => this.assets.characterUrl(projectId, card.id, rel),
        onVersion: (saved) => {
          if (saved) successCount += 1;
          bump(1);
        },
        onError: (msg) => {
          firstError ??= msg;
        },
      });
      const idx = this.repo.get(projectId)!.characters.findIndex((c) => c.id === card.id);
      const characters = [...this.repo.get(projectId)!.characters];
      characters[idx] = { ...card, versions };
      this.repo.update({ ...this.repo.get(projectId)!, characters });
    };

    const genLocation = async (loc: LocationCard): Promise<void> => {
      if (loc.versions.filter((v) => v.url).length >= PORTRAIT_VERSIONS) {
        successCount += loc.versions.filter((v) => v.url).length;
        bump(PORTRAIT_VERSIONS);
        return;
      }
      const prompt = buildLocationPrompt(styleAnchor, loc, locationSize);
      const baseSeed = hashSeed(`${projectId}:${loc.id}:${loc.description}`) >>> 0;
      const versions = await this.generateImageVariants(projectId, {
        prompt,
        baseSeed,
        size: locationSize,
        sse: (status, error) =>
          this.hub.publish(projectId, { projectId, type: 'location', loc_id: loc.id, status, error }),
        write: (rel, png) => this.assets.writeLocationBinary(projectId, loc.id, rel, png),
        url: (rel) => this.assets.locationUrl(projectId, loc.id, rel),
        onVersion: (saved) => {
          if (saved) successCount += 1;
          bump(1);
        },
        onError: (msg) => {
          firstError ??= msg;
        },
      });
      const idx = this.repo.get(projectId)!.locations.findIndex((l) => l.id === loc.id);
      const locations = [...this.repo.get(projectId)!.locations];
      locations[idx] = { ...loc, versions };
      this.repo.update({ ...this.repo.get(projectId)!, locations });
    };

    // 资产间并行（角色 ≤8、地点 ≤12，并发 3 足够摊薄网络延迟且避免图服务限流）
    const jobs: (() => Promise<void>)[] = [
      ...record.characters.map((c) => () => genCharacter(c)),
      ...record.locations.map((l) => () => genLocation(l)),
    ];
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= jobs.length) return;
        await jobs[i]!();
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PORTRAIT_CONCURRENCY, jobs.length) }, () => worker()),
    );

    if (successCount === 0) {
      throw new Error(`all character/location assets failed: ${firstError ?? 'unknown error'}`);
    }
  }

  /** 单资产一轮 PORTRAIT_VERSIONS 版：生成→审核（失败换 seed 重试），落盘返回版本列表 */
  private async generateImageVariants(
    projectId: string,
    opts: {
      prompt: string;
      baseSeed: number;
      size: { width: number; height: number };
      /** 卡点重生成：在旧版本后追加新一轮；批量首轮缺省 */
      existing?: CharacterCard['versions'];
      sse: (status: 'generating' | 'ready' | 'failed', error?: string) => void;
      write: (relPath: string, png: Uint8Array) => void;
      url: (relPath: string) => string;
      /** 每版结束回调（saved=该版是否成功落盘） */
      onVersion: (saved: boolean) => void;
      onError: (msg: string) => void;
    },
  ): Promise<CharacterCard['versions']> {
    const record = this.repo.get(projectId)!;
    const versions: CharacterCard['versions'] = [...(opts.existing ?? [])];
    for (let v = 0; v < PORTRAIT_VERSIONS; v++) {
      const seed = (opts.baseSeed + versions.length * 977 + v * 977) >>> 0;
      opts.sse('generating');
      let lastError = 'image moderation rejected';
      let saved = false;
      for (let attempt = 0; attempt < IMAGE_MODERATION_ATTEMPTS && !saved; attempt++) {
        try {
          const png = await this.providers.image.generateImage({
            prompt: opts.prompt,
            style: record.style,
            width: opts.size.width,
            height: opts.size.height,
            seed: seed + attempt * 101,
          });
          const mod = await this.providers.moderation.checkImage(png);
          if (mod.verdict === 'pass') {
            const rel = `v${versions.length + 1}.png`;
            opts.write(rel, png);
            versions.push({ seed, url: opts.url(rel) });
            saved = true;
          } else {
            lastError = mod.reason ? `image moderation rejected: ${mod.reason}` : lastError;
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }
      if (!saved) {
        opts.onError(lastError);
        versions.push({ seed, failed: true, error: lastError });
      }
      opts.sse(saved ? 'ready' : 'failed', saved ? undefined : lastError);
      opts.onVersion(saved);
    }
    return versions;
  }

  /**
   * 卡点操作：改角色描述（先审核）→ 追加新一轮 3 版立绘。
   * 返回后由调用方重新入队 run()，generatePortraits 幂等跳过已有版本。
   */
  async regeneratePortrait(
    projectId: string,
    charId: string,
    description?: { appearance?: string; costume?: string },
  ): Promise<void> {
    const record = this.repo.get(projectId);
    if (!record) throw new Error(`project not found: ${projectId}`);
    if (record.state !== 'awaiting_character_confirmation') {
      throw new Error(`portrait regeneration only allowed while awaiting confirmation (state: ${record.state})`);
    }
    const idx = record.characters.findIndex((c) => c.id === charId);
    if (idx < 0) throw new Error(`character not found: ${charId}`);
    const card = record.characters[idx]!;
    const regens = record.counters.portraitRegens[charId] ?? 0;
    if (regens >= MAX_PORTRAIT_REGENS) throw new Error(`portrait regeneration limit reached for ${charId}`);

    const nextAppearance = description?.appearance ?? card.appearance;
    const nextCostume = description?.costume ?? card.costume;
    const mod = await this.providers.moderation.checkText(`${nextAppearance} ${nextCostume ?? ''}`);
    if (mod.verdict === 'reject') {
      throw new Error(`description rejected: ${mod.reason ?? 'moderation'}`);
    }

    // 换描述后旧版本作废（一致性锚已变），清空重出；同描述重抽只是换 seed 追加
    const sameLook = nextAppearance === card.appearance && nextCostume === card.costume;
    const fresh: CharacterCard = {
      ...card,
      appearance: nextAppearance,
      costume: nextCostume,
      versions: sameLook ? card.versions : [],
      selected: sameLook ? card.selected : undefined,
    };
    const characters = [...record.characters];
    characters[idx] = fresh;
    this.repo.update({
      ...record,
      characters,
      counters: {
        ...record.counters,
        portraitRegens: { ...record.counters.portraitRegens, [charId]: regens + 1 },
      },
    });
    await this.generatePortraitVersions(projectId, fresh);
  }

  /** 单角色补出一轮版本（卡点期间用户点「重生成」，不进状态机） */
  private async generatePortraitVersions(projectId: string, card: CharacterCard): Promise<void> {
    const record = this.repo.get(projectId)!;
    const script = this.assets.readScript(projectId);
    const baseSeed = (hashSeed(`${projectId}:${card.id}:${card.appearance}:${record.counters.portraitRegens[card.id] ?? 0}`) >>> 0);
    const versions = await this.generateImageVariants(projectId, {
      prompt: buildPortraitPrompt(script.style_anchor, card),
      baseSeed,
      size: { width: 1024, height: 1024 },
      existing: card.versions,
      sse: (status, error) =>
        this.hub.publish(projectId, { projectId, type: 'portrait', char_id: card.id, status, error }),
      write: (rel, png) => this.assets.writeCharacterBinary(projectId, card.id, rel, png),
      url: (rel) => this.assets.characterUrl(projectId, card.id, rel),
      onVersion: () => undefined,
      onError: () => undefined,
    });
    const cur = this.repo.get(projectId)!;
    const characters = cur.characters.map((c) => (c.id === card.id ? { ...c, versions } : c));
    this.repo.update({ ...cur, characters });
  }

  /** 单地点补出一轮场景图（镜像角色） */
  private async generateLocationVersions(projectId: string, loc: LocationCard): Promise<void> {
    const record = this.repo.get(projectId)!;
    const script = this.assets.readScript(projectId);
    const baseSeed = (hashSeed(`${projectId}:${loc.id}:${loc.description}:${record.counters.locationRegens[loc.id] ?? 0}`) >>> 0);
    const versions = await this.generateImageVariants(projectId, {
      prompt: buildLocationPrompt(script.style_anchor, loc, this.projectPageSize(record)),
      baseSeed,
      size: this.projectPageSize(record),
      existing: loc.versions,
      sse: (status, error) =>
        this.hub.publish(projectId, { projectId, type: 'location', loc_id: loc.id, status, error }),
      write: (rel, png) => this.assets.writeLocationBinary(projectId, loc.id, rel, png),
      url: (rel) => this.assets.locationUrl(projectId, loc.id, rel),
      onVersion: () => undefined,
      onError: () => undefined,
    });
    const cur = this.repo.get(projectId)!;
    const locations = cur.locations.map((l) => (l.id === loc.id ? { ...l, versions } : l));
    this.repo.update({ ...cur, locations });
  }

  /** 卡点操作：选定某版立绘（seed 定位版本） */
  selectPortrait(projectId: string, charId: string, seed: number): ScriptProjectRecord {
    const record = this.repo.get(projectId);
    if (!record) throw new Error(`project not found: ${projectId}`);
    if (record.state !== 'awaiting_character_confirmation') {
      throw new Error(`select only allowed while awaiting confirmation (state: ${record.state})`);
    }
    const card = record.characters.find((c) => c.id === charId);
    if (!card) throw new Error(`character not found: ${charId}`);
    const version = card.versions.find((v) => v.seed === seed && v.url);
    if (!version) throw new Error(`portrait version not found: ${charId}/${seed}`);
    const characters = record.characters.map((c) =>
      c.id === charId ? { ...c, selected: seed } : c,
    );
    const updated = { ...record, characters, updated_at: Date.now() };
    this.repo.update(updated);
    return updated;
  }

  /** 卡点操作：选定某版场景图（seed 定位版本） */
  selectLocation(projectId: string, locId: string, seed: number): ScriptProjectRecord {
    const record = this.repo.get(projectId);
    if (!record) throw new Error(`project not found: ${projectId}`);
    if (record.state !== 'awaiting_character_confirmation') {
      throw new Error(`select only allowed while awaiting confirmation (state: ${record.state})`);
    }
    const card = record.locations.find((l) => l.id === locId);
    if (!card) throw new Error(`location not found: ${locId}`);
    const version = card.versions.find((v) => v.seed === seed && v.url);
    if (!version) throw new Error(`location version not found: ${locId}/${seed}`);
    const locations = record.locations.map((l) => (l.id === locId ? { ...l, selected: seed } : l));
    const updated = { ...record, locations, updated_at: Date.now() };
    this.repo.update(updated);
    return updated;
  }

  /**
   * 卡点操作：改场景描述（先审核）→ 追加新一轮 3 版场景图。
   * 镜像 regeneratePortrait：换描述后旧版本作废，同描述重抽只是换 seed 追加。
   */
  async regenerateLocation(
    projectId: string,
    locId: string,
    description?: string,
  ): Promise<void> {
    const record = this.repo.get(projectId);
    if (!record) throw new Error(`project not found: ${projectId}`);
    if (record.state !== 'awaiting_character_confirmation') {
      throw new Error(`location regeneration only allowed while awaiting confirmation (state: ${record.state})`);
    }
    const idx = record.locations.findIndex((l) => l.id === locId);
    if (idx < 0) throw new Error(`location not found: ${locId}`);
    const card = record.locations[idx]!;
    const regens = record.counters.locationRegens[locId] ?? 0;
    if (regens >= MAX_LOCATION_REGENS) throw new Error(`location regeneration limit reached for ${locId}`);

    const nextDescription = description ?? card.description;
    const mod = await this.providers.moderation.checkText(nextDescription);
    if (mod.verdict === 'reject') {
      throw new Error(`description rejected: ${mod.reason ?? 'moderation'}`);
    }

    const sameLook = nextDescription === card.description;
    const fresh: LocationCard = {
      ...card,
      description: nextDescription,
      versions: sameLook ? card.versions : [],
      selected: sameLook ? card.selected : undefined,
    };
    const locations = [...record.locations];
    locations[idx] = fresh;
    this.repo.update({
      ...record,
      locations,
      counters: {
        ...record.counters,
        locationRegens: { ...record.counters.locationRegens, [locId]: regens + 1 },
      },
    });
    await this.generateLocationVersions(projectId, fresh);
  }

  /** 被任一场引用的地点 id（旧剧本无 location_id 引用时为空） */
  private referencedLocationIds(script: ScriptAnalysis): Set<string> {
    const ids = new Set<string>();
    for (const e of script.episodes) {
      for (const s of e.scenes) if (s.location_id) ids.add(s.location_id);
    }
    return ids;
  }

  /** 卡点放行：全部角色 + 被引用场景已选定才进分镜工作台（此后逐场手动生成） */
  confirmCharacters(projectId: string): ScriptProjectRecord {
    const record = this.repo.get(projectId);
    if (!record) throw new Error(`project not found: ${projectId}`);
    if (record.state !== 'awaiting_character_confirmation') {
      throw new Error(`confirm only allowed while awaiting confirmation (state: ${record.state})`);
    }
    const missing = record.characters.filter((c) => c.selected === undefined);
    if (missing.length > 0) {
      throw new Error(`characters not selected: ${missing.map((c) => c.name).join(', ')}`);
    }
    const referenced = this.referencedLocationIds(this.assets.readScript(projectId));
    const missingLocs = record.locations.filter((l) => referenced.has(l.id) && l.selected === undefined);
    if (missingLocs.length > 0) {
      throw new Error(`locations not selected: ${missingLocs.map((l) => l.name).join(', ')}`);
    }
    // 定稿角色卡/场景卡的外形、服装、音色、描述写回 script.json，供后续 prompt 与配音使用
    const script = this.assets.readScript(projectId);
    const merged: ScriptAnalysis = {
      ...script,
      characters: script.characters.map((c) => {
        const card = record.characters.find((k) => k.id === c.id)!;
        return { ...c, appearance: card.appearance, costume: card.costume, voice: card.voice ?? c.voice };
      }),
      locations: script.locations.map((l) => {
        const card = record.locations.find((k) => k.id === l.id);
        return card ? { ...l, description: card.description } : l;
      }),
    };
    this.assets.writeScript(projectId, merged);
    const updated = this.apply(projectId, { type: 'CONFIRM_CHARACTERS' });
    // 分镜清单初始化：保留已有场次清单（重跑/重画后的产物），补新场
    const byId = new Map(updated.scenes.map((m) => [m.scene_id, m]));
    const scenes = this.allScenes(merged);
    const manifests: SceneManifest[] = scenes.map(
      (s) =>
        byId.get(s.id) ?? {
          scene_id: s.id,
          seed: (hashSeed(`${projectId}:${s.id}`) + (updated.counters.sceneRegens[s.id] ?? 0)) >>> 0,
        },
    );
    this.repo.update({
      ...this.repo.get(projectId)!,
      scenes: manifests,
      progress: { units_done: 0, units_total: scenes.length },
    });
    return this.repo.get(projectId)!;
  }

  /** 按项目画幅取渲染尺寸：portrait 固定 1080×1920，其余用全局配置 */
  private projectPageSize(record: ScriptProjectRecord): { width: number; height: number } {
    return record.format === 'portrait' ? PORTRAIT_SIZE : this.config.pageSize;
  }

  /** 剧本的全部场次（按集顺序展平） */
  private allScenes(script: ScriptAnalysis): ScriptScene[] {
    return script.episodes.flatMap((e) => e.scenes);
  }

  /** 逐场手动生成的前置校验：工作台/就绪态 + 场次与清单存在 */
  private sceneContext(projectId: string, sceneId: string): {
    record: ScriptProjectRecord;
    script: ScriptAnalysis;
    scene: ScriptScene;
  } {
    const record = this.repo.get(projectId);
    if (!record) throw new Error(`project not found: ${projectId}`);
    if (record.state !== 'storyboard_review' && record.state !== 'ready' && record.state !== 'completed') {
      throw new Error(`scene generation only allowed in the storyboard workbench (state: ${record.state})`);
    }
    const script = this.assets.readScript(projectId);
    const scene = this.allScenes(script).find((s) => s.id === sceneId);
    if (!scene) throw new Error(`scene not found: ${sceneId}`);
    if (!record.scenes.some((m) => m.scene_id === sceneId)) {
      throw new Error(`scene manifest not found: ${sceneId}`);
    }
    return { record, script, scene };
  }

  private saveScenes(projectId: string, manifests: SceneManifest[]): void {
    this.repo.update({
      ...this.repo.get(projectId)!,
      scenes: [...manifests],
      updated_at: Date.now(),
    });
  }

  /** 单场出片后推进：全部场次片段就绪时自动进入 ready（允许导出） */
  private advanceStoryboardIfNeeded(projectId: string): void {
    const cur = this.repo.get(projectId)!;
    const done = cur.scenes.filter((m) => m.clip_url).length;
    this.publishProgress(projectId, done, cur.scenes.length);
    if (cur.state === 'storyboard_review' && cur.scenes.length > 0 && done === cur.scenes.length) {
      this.apply(projectId, { type: 'STORYBOARD_DONE' });
      this.hub.publish(projectId, { projectId, type: 'completed' });
    }
  }

  /** 某场片段作废后回退：ready/completed 退回分镜工作台并丢弃旧成片 */
  private reopenStoryboardIfNeeded(projectId: string): void {
    const cur = this.repo.get(projectId)!;
    const done = cur.scenes.filter((m) => m.clip_url).length;
    this.publishProgress(projectId, done, cur.scenes.length);
    if (done === cur.scenes.length) return;
    if (cur.state === 'ready') {
      this.apply(projectId, { type: 'STORYBOARD_REOPEN' });
      this.repo.update({ ...this.repo.get(projectId)!, export: undefined });
    } else if (cur.state === 'completed') {
      this.repo.update({
        ...cur,
        state: 'storyboard_review',
        export: undefined,
        updated_at: Date.now(),
      });
      this.hub.publish(projectId, { projectId, type: 'state', state: 'storyboard_review' });
    }
  }

  /**
   * 单场视频片段（用户逐场点击触发）：r2v 参考图直出 + 配音（TTS 便宜，随片段自动补齐）。
   * 参考图 = 该场选定场景图 + 出场角色选定立绘（≤R2V_MAX_REFS，超限文字描述兜底）；
   * r2v 失败只标 clip_failed 供重画，配音失败不阻塞。
   * 该场出片后若全部场次齐备，自动进入 ready。
   */
  async generateSceneClip(projectId: string, sceneId: string): Promise<void> {
    const { record, script, scene } = this.sceneContext(projectId, sceneId);
    const manifests = record.scenes.map((m) => ({ ...m }));
    const manifest = manifests.find((m) => m.scene_id === sceneId)!;
    if (manifest.clip_url) {
      this.advanceStoryboardIfNeeded(projectId);
      return;
    }

    const voiceOf = (speaker: string): string | undefined => {
      if (speaker === NARRATOR) return undefined;
      const card = record.characters.find((c) => c.name === speaker);
      return card?.voice ? normalizeVoice(card.voice) : undefined;
    };

    this.hub.publish(projectId, { projectId, type: 'scene_clip', scene_id: sceneId, status: 'generating' });
    try {
      await this.renderSceneClip(projectId, record, script, scene, manifest);
      manifest.clip_failed = undefined;
      this.hub.publish(projectId, { projectId, type: 'scene_clip', scene_id: sceneId, status: 'ready' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      manifest.clip_failed = true;
      this.saveScenes(projectId, manifests);
      this.hub.publish(projectId, {
        projectId,
        type: 'scene_clip',
        scene_id: sceneId,
        status: 'failed',
        error: msg,
      });
      this.advanceStoryboardIfNeeded(projectId);
      throw err;
    }
    this.saveScenes(projectId, manifests);
    // 配音缺失才补（逐场 TTS，失败只跳过语音不影响片段）
    if (!manifest.narration_url) {
      await this.synthesizeSceneNarration(projectId, script, scene, manifest, voiceOf);
      this.saveScenes(projectId, manifests);
    }
    this.advanceStoryboardIfNeeded(projectId);
  }

  /** url → 磁盘绝对路径（url 由 AssetStore.projectUrl 产出，前缀可逆） */
  private urlToPath(projectId: string, url: string): string {
    return this.assets.rootPath('projects', projectId, url.replace(`/assets/projects/${projectId}/`, ''));
  }

  /**
   * 单场 r2v：选定场景图（图1）+ 出场角色选定立绘进 media，时长按台词估算。
   * 无任何参考图（旧项目无场景资产且该场无出场角色）拒绝出片——
   * 文字锚定一致性无法保证，宁可让用户先补资产。
   */
  private async renderSceneClip(
    projectId: string,
    record: ScriptProjectRecord,
    script: ScriptAnalysis,
    scene: ScriptScene,
    manifest: SceneManifest,
  ): Promise<void> {
    const provider = this.providers.videoClip;
    if (!provider) throw new Error('video provider not configured');

    const locCard = scene.location_id
      ? record.locations.find((l) => l.id === scene.location_id)
      : undefined;
    const locVersion = locCard?.versions.find((v) => v.seed === locCard.selected && v.url);
    const locationImage =
      locCard && locVersion
        ? { name: locCard.name, png: new Uint8Array(readFileSync(this.urlToPath(projectId, locVersion.url!))) }
        : undefined;

    const cast = sceneCast(record.characters, scene).filter((c) =>
      c.versions.some((v) => v.seed === c.selected && v.url),
    );
    const { inMedia, described } = selectR2vCast(cast, scene, locationImage ? R2V_MAX_REFS - 1 : R2V_MAX_REFS);
    const castIn: CastReference[] = inMedia.map((c) => {
      const version = c.versions.find((v) => v.seed === c.selected && v.url)!;
      return { card: c, png: new Uint8Array(readFileSync(this.urlToPath(projectId, version.url!))) };
    });

    const { prompt, referenceImages } = buildR2vRequest({ script, scene, locationImage, castIn, castOut: described });
    if (referenceImages.length === 0) {
      throw new Error(`scene ${scene.id} has no reference images: select a scene image or character portraits first`);
    }

    const { video } = await provider.generateClip({
      referenceImages,
      prompt,
      ratio: record.format === 'portrait' ? '9:16' : '16:9',
      durationSec: estimateClipDurationSec(script, scene),
      resolution: '720P',
      seed: manifest.seed,
    });
    this.assets.writeSceneBinary(projectId, scene.id, 'clip.mp4', video);
    const clipPath = this.assets.rootPath('projects', projectId, 'scenes', scene.id, 'clip.mp4');
    manifest.clip_url = this.assets.sceneUrl(projectId, scene.id, 'clip.mp4');
    manifest.clip_duration_ms = await (this.config.probeDurationMs ?? probeDurationMs)(clipPath);
  }

  /**
   * 单场配音：旁白段（默认音色）+ 逐条对白段（角色音色），
   * 角色音色失败回退旁白重试一次；段间 250ms 停顿拼接。
   * 整场失败只跳过语音（发 failed 事件），不阻塞成片。
   */
  private async synthesizeSceneNarration(
    projectId: string,
    script: ScriptAnalysis,
    scene: ScriptScene,
    manifest: SceneManifest,
    voiceOf: (speaker: string) => string | undefined,
  ): Promise<void> {
    const provider = this.providers.tts;
    if (!provider || manifest.narration_url) return;
    const segments: { speaker: string; text: string }[] = [];
    if (scene.narration) segments.push({ speaker: NARRATOR, text: scene.narration });
    for (const d of scene.dialogues) segments.push({ speaker: d.speaker, text: d.line });
    if (segments.length === 0) return;

    this.hub.publish(projectId, { projectId, type: 'scene_narration', scene_id: scene.id, status: 'generating' });
    try {
      const audios: Uint8Array[] = [];
      for (const seg of segments) {
        const voice = voiceOf(seg.speaker);
        try {
          const { audio } = await provider.synthesize({ text: seg.text, lang: script.lang, voice });
          audios.push(audio);
        } catch (err) {
          if (voice === undefined) throw err;
          const { audio } = await provider.synthesize({ text: seg.text, lang: script.lang });
          audios.push(audio);
        }
      }
      const wav = audios.length === 1 ? audios[0]! : concatWavs(audios, 250);
      this.assets.writeSceneBinary(projectId, scene.id, 'narration.wav', wav);
      const wavPath = this.assets.rootPath('projects', projectId, 'scenes', scene.id, 'narration.wav');
      manifest.narration_url = this.assets.sceneUrl(projectId, scene.id, 'narration.wav');
      manifest.narration_duration_ms = await (this.config.probeDurationMs ?? probeDurationMs)(wavPath);
      this.hub.publish(projectId, { projectId, type: 'scene_narration', scene_id: scene.id, status: 'ready' });
    } catch (err) {
      this.hub.publish(projectId, {
        projectId,
        type: 'scene_narration',
        scene_id: scene.id,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 单场重画（用户在分镜工作台/ready 后触发）：换 seed 重跑该场 r2v，
   * 保留已合成的配音。无次数限制——逐场手动点击本身即成本控制。
   * 片段作废期间项目退回 storyboard_review，旧成片丢弃；重画完成若齐备自动回 ready。
   */
  async regenerateScene(projectId: string, sceneId: string): Promise<void> {
    const { record } = this.sceneContext(projectId, sceneId);
    const regens = record.counters.sceneRegens[sceneId] ?? 0;
    const manifests = record.scenes.map((m) => ({ ...m }));
    const manifest = manifests.find((m) => m.scene_id === sceneId)!;
    manifest.seed = hashSeed(`${projectId}:${sceneId}:regen${regens + 1}`) >>> 0;
    manifest.clip_url = undefined;
    manifest.clip_duration_ms = undefined;
    manifest.clip_failed = undefined;
    this.repo.update({
      ...record,
      scenes: manifests,
      counters: {
        ...record.counters,
        sceneRegens: { ...record.counters.sceneRegens, [sceneId]: regens + 1 },
      },
      updated_at: Date.now(),
    });
    this.reopenStoryboardIfNeeded(projectId);

    await this.generateSceneClip(projectId, sceneId);
  }
}
