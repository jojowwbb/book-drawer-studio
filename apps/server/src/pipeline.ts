import type { SceneSpec } from '@pb/renderer';
import { concatWavs, encodeSolidPng, hashSeed, NARRATOR, normalizeVoice, repairSegments } from '@pb/ai-core';
import type { Lang, ProviderBundle, Story } from '@pb/ai-core';
import type { BookEvent } from './state-machine';
import { transition, MAX_PAGE_REGENS } from './state-machine';
import type { AssetStore } from './asset-store';
import type { BookRecord, BookRepo } from './book-repo';
import type { EventHub } from './events';
import type { PageAssets } from './page-assets';
import type { ClipSource } from './export/clip-source';
import { probeDurationMs } from './export/ffmpeg';
import { buildBookSpec, buildCoverImagePrompt, buildFallbackImagePrompt, buildImagePrompt, buildSceneSpec, buildTitleSceneSpec, coverNarrationText, TITLE_PAGE_ID } from './scene-assembly';
import { runPool } from './util/run-pool';

export interface PipelineConfig {
  pageSize: { width: number; height: number };
  /** AI 片段时长探测（默认 ffprobe）；测试可注入桩 */
  probeDurationMs?: (path: string) => Promise<number>;
  /**
   * 音色确认暂停点：缺省（true）在故事定稿后停在 voice_review，等用户确认角色音色
   * （POST /confirm-voices）再继续插画与配音；false 自动放行（自动化测试/批量产线）。
   */
  voiceReview?: boolean;
}

const IMAGE_MODERATION_ATTEMPTS = 3;

/** 逐页文生图的并发上限（页与页互不依赖：prompt/seed 全部派生自已定稿的 story） */
export const PAGE_IMAGE_CONCURRENCY = 10;

/** 片段渲染并发上限：与 HarnessDriver page 池一致（每 page 一个 WebGL context，受 CPU/GPU 约束） */
export const CLIP_CONCURRENCY = 3;

/** 旁白 TTS 并发上限（纯网络 I/O，适度并发即可，避免供应商 QPS 限流） */
export const NARRATION_CONCURRENCY = 6;

/** 竖屏画幅的渲染尺寸（9:16 短视频平台）；横版用全局 pageSize */
export const PORTRAIT_SIZE = { width: 1080, height: 1920 };

/** 插画彻底失败时的占位底色（柔和暖灰，不刺眼） */
const PLACEHOLDER_RGB: [number, number, number] = [238, 230, 220];

/** 按书取渲染尺寸：portrait 固定 1080x1920，其余（含旧书缺省）用全局配置 */
export function bookPageSize(
  record: { format?: 'landscape' | 'portrait' },
  fallback: { width: number; height: number },
): { width: number; height: number } {
  return record.format === 'portrait' ? PORTRAIT_SIZE : fallback;
}

/** 限并发工作池：见 util/run-pool（多产线共用） */

export class Pipeline {
  constructor(
    private readonly providers: ProviderBundle,
    private readonly repo: BookRepo,
    private readonly assets: AssetStore,
    private readonly hub: EventHub,
    private readonly config: PipelineConfig,
    private readonly clipSource: ClipSource,
  ) {}

  private apply(bookId: string, event: BookEvent): BookRecord {
    const record = this.repo.get(bookId);
    if (!record) throw new Error(`book not found: ${bookId}`);
    const result = transition(record.state, event, record.counters, { enhance: record.enhance });
    if (!result.ok) throw new Error(result.error);
    const updated: BookRecord = {
      ...record,
      state: result.state,
      counters: result.counters,
      updated_at: Date.now(),
    };
    if (event.type === 'STAGE_FAILED') updated.error = event.error;
    if (result.state === 'ready') updated.error = undefined;
    this.repo.update(updated);
    this.hub.publish(bookId, { bookId, type: 'state', state: result.state });
    if (result.state.startsWith('failed_')) {
      this.hub.publish(bookId, {
        bookId,
        type: 'failed',
        error: updated.error ?? result.state,
      });
    }
    return updated;
  }

  private publishProgress(bookId: string, done: number, total: number): void {
    this.repo.update({
      ...this.repo.get(bookId)!,
      progress: { pages_done: done, pages_total: total },
    });
    this.hub.publish(bookId, {
      bookId,
      type: 'progress',
      progress: { pages_done: done, pages_total: total },
    });
  }

  async run(bookId: string): Promise<void> {
    let record = this.repo.get(bookId);
    if (!record) throw new Error(`book not found: ${bookId}`);

    if (record.state === 'created') {
      record = this.apply(bookId, { type: 'START' });
    }
    if (record.state === 'story_generating' || record.state === 'story_moderating') {
      const ok = await this.runStoryAndModeration(bookId);
      if (!ok) return;
      record = this.repo.get(bookId)!;
    }
    if (record.state === 'voice_review') {
      // 音色确认暂停点：故事已定稿，停在角色列表让用户核对/改配音色，
      // 由 POST /confirm-voices 推进到 pages_generating 后重新入队续跑。
      // voiceReview=false（自动化测试/批量）时直接放行。
      if (this.config.voiceReview !== false) return;
      record = this.apply(bookId, { type: 'STAGE_DONE' });
    }
    if (record.state === 'pages_generating') {
      const ok = await this.runStageWithRetry(bookId, 'pages_generating', () =>
        this.generatePagesAndAssemble(bookId),
      );
      if (!ok) return;
      record = this.apply(bookId, { type: 'STAGE_DONE' });
    }
    if (record.state === 'enhance_generating') {
      // 逐页视频片段：插画经 PixiJS headless 逐帧渲染（两种模式同一来源）
      const ok = await this.runStageWithRetry(bookId, 'enhance_generating', () =>
        this.generateClips(bookId),
      );
      if (!ok) return;
      record = this.apply(bookId, { type: 'STAGE_DONE' });
    }
    if (record.state === 'ready') {
      this.hub.publish(bookId, { bookId, type: 'completed' });
    }
  }

  /**
   * 音色确认阶段手动改配音色：仅 voice_review 状态可用（此时插画/配音还没开始，
   * 改 story.characters[].voice 零成本）。所有语言版本的同名角色一起更新。
   * key 用 NARRATOR（「旁白」）时改的是 story.narrator_voice（旁白/片头配音色）。
   * 未知音色经 normalizeVoice 回退默认（undefined=供应商默认旁白音色）。
   */
  setCharacterVoices(bookId: string, voices: Record<string, string | undefined>): void {
    const record = this.repo.get(bookId);
    if (!record) throw new Error(`book not found: ${bookId}`);
    if (record.state !== 'voice_review') throw new Error(`voices only editable in voice_review, not ${record.state}`);
    for (const lang of record.langs) {
      const story = this.assets.readStory(bookId, lang);
      let touched = false;
      if (NARRATOR in voices) {
        story.narrator_voice = normalizeVoice(voices[NARRATOR]);
        touched = true;
      }
      story.characters = story.characters.map((c) => {
        if (!(c.name in voices)) return c;
        const voice = normalizeVoice(voices[c.name]);
        touched = true;
        return { ...c, voice };
      });
      if (touched) this.assets.writeStory(bookId, lang, story);
    }
  }

  /**
   * 音色确认完毕：把 voice_review 推进到 pages_generating。
   * 调用方（API）随后重新入队 run() 续跑插画与配音。
   */
  confirmVoices(bookId: string): void {
    const record = this.repo.get(bookId);
    if (!record) throw new Error(`book not found: ${bookId}`);
    if (record.state !== 'voice_review') throw new Error(`voices only confirmable in voice_review, not ${record.state}`);
    this.apply(bookId, { type: 'STAGE_DONE' });
  }

  private async runStageWithRetry(
    bookId: string,
    stage: string,
    fn: () => Promise<void>,
  ): Promise<boolean> {
    for (;;) {
      try {
        await fn();
        return true;
      } catch (err) {
        const after = this.apply(bookId, {
          type: 'STAGE_FAILED',
          error: err instanceof Error ? err.message : String(err),
        });
        if (after.state === `failed_${stage}`) return false;
      }
    }
  }

  private async runStoryAndModeration(bookId: string): Promise<boolean> {
    let record = this.repo.get(bookId)!;
    if (record.state === 'story_generating') {
      if (!(await this.runStageWithRetry(bookId, 'story_generating', () => this.generateStories(bookId)))) {
        return false;
      }
      record = this.apply(bookId, { type: 'STAGE_DONE' });
    }
    for (;;) {
      let verdict: { passed: boolean; reason?: string };
      try {
        verdict = await this.moderateStories(bookId);
      } catch (err) {
        const after = this.apply(bookId, {
          type: 'STAGE_FAILED',
          error: err instanceof Error ? err.message : String(err),
        });
        if (after.state === 'failed_story_moderating') return false;
        continue;
      }
      if (verdict.passed) {
        this.apply(bookId, { type: 'STAGE_DONE' });
        return true;
      }
      this.repo.update({ ...this.repo.get(bookId)!, last_reject_reason: verdict.reason });
      const after = this.apply(bookId, { type: 'TEXT_REJECTED', reason: verdict.reason ?? 'rejected' });
      if (after.state === 'failed_story_moderating') return false;
      if (!(await this.runStageWithRetry(bookId, 'story_generating', () => this.generateStories(bookId)))) {
        return false;
      }
      this.apply(bookId, { type: 'STAGE_DONE' });
    }
  }

  private async generateStories(bookId: string): Promise<void> {
    const record = this.repo.get(bookId)!;
    let primaryPageCount: number | undefined;
    for (const lang of record.langs) {
      let story = await this.providers.story.generateStory({
        theme: record.theme,
        title: record.title,
        style: record.style,
        lang,
        format: record.format,
        page_count: record.page_count,
        reject_reason: record.last_reject_reason,
      });
      // 用户指定书名：不依赖 AI 是否听话，强制覆盖书名与片头大标题
      if (record.title) {
        story = {
          ...story,
          title: record.title,
          cover: story.cover ? { ...story.cover, title: record.title } : story.cover,
        };
      }
      this.assets.writeStory(bookId, lang, story);
      primaryPageCount ??= story.pages.length;
    }
    // AI 自行分幕时回填进度总数（page_count 保持缺省，重试/恢复时继续自由分幕）
    if (record.page_count === undefined && primaryPageCount !== undefined) {
      this.repo.update({
        ...this.repo.get(bookId)!,
        progress: { pages_done: 0, pages_total: primaryPageCount },
      });
      this.hub.publish(bookId, {
        bookId,
        type: 'progress',
        progress: { pages_done: 0, pages_total: primaryPageCount },
      });
    }
  }

  private async moderateStories(bookId: string): Promise<{ passed: boolean; reason?: string }> {
    const record = this.repo.get(bookId)!;
    for (const lang of record.langs) {
      const story = this.assets.readStory(bookId, lang);
      const coverText = story.cover
        ? `${story.cover.title} ${story.cover.subtitle ?? ''} ${story.cover.tags.join(' ')}`
        : '';
      const text = [story.title, coverText, ...story.pages.map((p) => `${p.page_text} ${p.narration}`)].join('\n');
      const result = await this.providers.moderation.checkText(text);
      if (result.verdict === 'reject') {
        return { passed: false, reason: result.reason ?? `rejected (${lang})` };
      }
    }
    return { passed: true };
  }

  private async generatePagesAndAssemble(bookId: string): Promise<void> {
    const record = this.repo.get(bookId)!;
    const size = bookPageSize(record, this.config.pageSize);
    const storyByLang = new Map<Lang, Story>();
    for (const lang of record.langs) storyByLang.set(lang, this.assets.readStory(bookId, lang));
    const primary = storyByLang.get(record.langs[0]!)!;
    const total = primary.pages.length;

    // 片头封面与正文页无依赖，并行生成（页数统计不含片头，进度语义保持「正文页」）
    const coverTask = this.ensureCoverAssets(bookId, primary);

    // 限并发工作池：页与页无依赖，完成一页推进一次进度（乱序完成，done 单调递增）
    let done = 0;
    let next = 0;
    let placeholderCount = 0;
    let firstImageError: string | undefined;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= total) return;
        const page = primary.pages[i]!;
        let manifest = this.assets.tryReadPageAssets(bookId, page.page_id);
        // 占位图页在恢复重跑时自动再试一次（不占重画配额）
        if (!manifest || manifest.image_failed) {
          manifest = await this.buildPageAssets(bookId, primary, page.page_id, i);
        }
        if (manifest.image_failed) {
          placeholderCount += 1;
          firstImageError ??= manifest.image_error;
        }
        this.assets.writePageAssets(bookId, page.page_id, manifest);
        this.publishProgress(bookId, ++done, total);
      }
    };
    await Promise.all([
      coverTask,
      ...Array.from({ length: Math.min(PAGE_IMAGE_CONCURRENCY, total) }, () => worker()),
    ]);
    // 全军覆没多半是图像服务整体不可用：按阶段失败处理（可重试/恢复），而不是产出一整本占位图
    if (placeholderCount === total) {
      throw new Error(`all page images failed to generate: ${firstImageError ?? 'unknown error'}`);
    }

    for (const lang of record.langs) {
      const story = storyByLang.get(lang)!;
      const pageAssets = this.collectPageAssets(bookId, story);
      const spec = buildBookSpec({
        bookId,
        story,
        lang,
        style: record.style,
        size,
        pageAssets,
      });
      this.assets.writeBookSpec(bookId, lang, spec);
    }
  }

  /** 页面清单集合：正文页 + 已生成的片头封面（page_id='title'） */
  private collectPageAssets(bookId: string, story: Story): Map<string, PageAssets> {
    const pageAssets = new Map<string, PageAssets>();
    for (const page of story.pages) {
      const manifest = this.assets.tryReadPageAssets(bookId, page.page_id);
      if (!manifest) throw new Error(`assets missing after generation: ${page.page_id}`);
      pageAssets.set(page.page_id, manifest);
    }
    const title = this.assets.tryReadPageAssets(bookId, TITLE_PAGE_ID);
    if (title) pageAssets.set(TITLE_PAGE_ID, title);
    return pageAssets;
  }

  /** 片头封面插画：story.cover 存在且未生成时产 cover.png（整图即背景，无需抠图分层）。
   * force=true 时忽略已有清单强制重画（seed 已含重画计数）。 */
  private async ensureCoverAssets(bookId: string, story: Story, force = false): Promise<void> {
    if (!story.cover) return;
    if (!force && this.assets.tryReadPageAssets(bookId, TITLE_PAGE_ID)) return;
    const record = this.repo.get(bookId)!;
    const size = bookPageSize(record, this.config.pageSize);
    const seed = (hashSeed(`${bookId}:${TITLE_PAGE_ID}`) + (record.counters.pageRegens[TITLE_PAGE_ID] ?? 0)) >>> 0;
    const generated = await this.generatePageImage(
      bookId,
      TITLE_PAGE_ID,
      buildCoverImagePrompt(story, size),
      buildFallbackImagePrompt(story, size),
      seed,
      size,
    );
    const full = generated.png;
    // 旁白文本来自 story.cover（与插画无关），重画封面后保留已合成的语音
    const previous = this.assets.tryReadPageAssets(bookId, TITLE_PAGE_ID);
    this.assets.writePageBinary(bookId, TITLE_PAGE_ID, 'full.png', full);
    this.assets.writePageBinary(bookId, TITLE_PAGE_ID, 'background.png', full);
    this.assets.writePageAssets(bookId, TITLE_PAGE_ID, {
      page_id: TITLE_PAGE_ID,
      seed,
      image_url: this.assets.pageUrl(bookId, TITLE_PAGE_ID, 'full.png'),
      background_url: this.assets.pageUrl(bookId, TITLE_PAGE_ID, 'background.png'),
      subject_urls: [],
      image_failed: generated.real ? undefined : true,
      narration_url: previous?.narration_url,
      narration_duration_ms: previous?.narration_duration_ms,
    });
  }

  private async generateClips(bookId: string): Promise<void> {
    const record = this.repo.get(bookId)!;
    const lang = record.langs[0]!;
    const size = bookPageSize(record, this.config.pageSize);
    const story = this.assets.readStory(bookId, lang);

    // 片段任务收集：片头幕（若有）+ 正文页中尚未渲染 canvas 片段的页。
    // manifest 对象在片段与旁白两条并行链之间共享同一引用：字段变更在内存合并后整体落盘，
    // 避免各自读盘再写导致的并发覆盖。
    interface ClipTask { pageId: string; manifest: PageAssets; sceneSpec: SceneSpec }
    const clipTasks: ClipTask[] = [];
    let done = 0;
    const total = story.pages.length;

    const titleManifest = this.assets.tryReadPageAssets(bookId, TITLE_PAGE_ID);
    if (story.cover && titleManifest && !titleManifest.clip_url) {
      clipTasks.push({
        pageId: TITLE_PAGE_ID,
        manifest: titleManifest,
        sceneSpec: buildTitleSceneSpec({
          story,
          size,
          assets: titleManifest,
        }),
      });
    }
    const narrationTasks: { pageId: string; manifest: PageAssets; page?: Story['pages'][number] }[] = [];
    if (story.cover && titleManifest) narrationTasks.push({ pageId: TITLE_PAGE_ID, manifest: titleManifest });
    for (const page of story.pages) {
      const manifest = this.assets.tryReadPageAssets(bookId, page.page_id);
      if (!manifest) throw new Error(`assets missing during clip stage: ${page.page_id}`);
      if (manifest.clip_url) {
        // canvas 片段已存在（可恢复）
        this.publishProgress(bookId, ++done, total);
      } else {
        clipTasks.push({
          pageId: page.page_id,
          manifest,
          sceneSpec: buildSceneSpec({
            page,
            lang,
            style: record.style,
            size,
            assets: manifest,
          }),
        });
      }
      narrationTasks.push({ pageId: page.page_id, manifest, page });
    }

    // 旁白（纯网络 I/O）与片段渲染（CPU/GPU）互不依赖，两条链同时开跑；
    // 单页旁白失败在 ensureNarration 内部消化，不阻塞成片
    await Promise.all([
      runPool(clipTasks, CLIP_CONCURRENCY, async (task) => {
        const { durationMs } = await this.clipSource.generateClip({
          bookId,
          pageId: task.pageId,
          sceneSpec: task.sceneSpec,
        });
        const clipUrl = this.assets.pageUrl(bookId, task.pageId, 'clip.mp4');
        task.manifest.clip_url = clipUrl;
        task.manifest.clip_duration_ms = durationMs;
        this.assets.writePageAssets(bookId, task.pageId, task.manifest);
        // 进度按正文页计（片头不占名额）：乱序完成，done 单调递增
        if (task.pageId !== TITLE_PAGE_ID) {
          this.publishProgress(bookId, ++done, total);
        }
      }),
      runPool(narrationTasks, NARRATION_CONCURRENCY, async (task) => {
        if (task.page) {
          await this.ensureNarration(bookId, lang, story, task.page, task.manifest);
        } else {
          await this.ensureTitleNarration(bookId, lang, story, task.manifest);
        }
      }),
    ]);
  }

  private async buildPageAssets(
    bookId: string,
    story: Story,
    pageId: string,
    pageIndex: number,
  ): Promise<PageAssets> {
    const record = this.repo.get(bookId)!;
    const page = story.pages[pageIndex]!;
    const size = bookPageSize(record, this.config.pageSize);
    const seed = (hashSeed(`${bookId}:${pageId}`) + (record.counters.pageRegens[pageId] ?? 0)) >>> 0;

    const generated = await this.generatePageImage(
      bookId,
      pageId,
      buildImagePrompt(story, page, size),
      buildFallbackImagePrompt(story, size),
      seed,
      size,
    );

    // 占位图无需抠图分层（避免在兜底路径上再引入新的失败源）
    if (!generated.real) {
      this.assets.writePageBinary(bookId, pageId, 'full.png', generated.png);
      this.assets.writePageBinary(bookId, pageId, 'background.png', generated.png);
      return {
        page_id: pageId,
        seed,
        image_url: this.assets.pageUrl(bookId, pageId, 'full.png'),
        background_url: this.assets.pageUrl(bookId, pageId, 'background.png'),
        subject_urls: [],
        image_failed: true,
        image_error: generated.error,
      };
    }

    const full = generated.png;
    const matte = await this.providers.matting.matte(full, seed);
    this.assets.writePageBinary(bookId, pageId, 'full.png', full);
    this.assets.writePageBinary(bookId, pageId, 'background.png', matte.background);
    matte.subjects.forEach((s, i) => {
      this.assets.writePageBinary(bookId, pageId, `subjects/s${i}.png`, s);
    });
    if (matte.foreground) {
      this.assets.writePageBinary(bookId, pageId, 'foreground.png', matte.foreground);
    }

    return {
      page_id: pageId,
      seed,
      image_url: this.assets.pageUrl(bookId, pageId, 'full.png'),
      background_url: this.assets.pageUrl(bookId, pageId, 'background.png'),
      subject_urls: matte.subjects.map((_, i) => this.assets.pageUrl(bookId, pageId, `subjects/s${i}.png`)),
      foreground_url: matte.foreground ? this.assets.pageUrl(bookId, pageId, 'foreground.png') : undefined,
    };
  }

  /**
   * 单页插画生成：生成失败或审核驳回都换 seed 重试，最后一次改用「软化 prompt」
   * （去掉具体场景与角色描述，只留画风 + 通用安全场景）再试。
   * 全部用尽仍拿不到图时返回纯色占位图（real=false）——该页跳过、不阻塞整本书，
   * 由用户在预览页单独重画。
   */
  private async generatePageImage(
    bookId: string,
    pageId: string,
    basePrompt: string,
    softPrompt: string,
    seed: number,
    size: { width: number; height: number },
  ): Promise<{ png: Uint8Array; real: boolean; error?: string }> {
    const record = this.repo.get(bookId)!;

    let lastError = 'image moderation rejected';
    for (let attempt = 0; attempt < IMAGE_MODERATION_ATTEMPTS; attempt++) {
      // 末次尝试改用软化 prompt：多数驳回源于具体场景/角色描述
      const prompt = attempt === IMAGE_MODERATION_ATTEMPTS - 1 ? softPrompt : basePrompt;
      try {
        const png = await this.providers.image.generateImage({
          prompt,
          style: record.style,
          width: size.width,
          height: size.height,
          seed: seed + attempt * 101,
        });
        const mod = await this.providers.moderation.checkImage(png);
        if (mod.verdict === 'pass') return { png, real: true };
        lastError = mod.reason ? `image moderation rejected: ${mod.reason}` : lastError;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    console.warn(`[pb] page image skipped for ${bookId}/${pageId}: ${lastError}`);
    this.hub.publish(bookId, {
      bookId,
      type: 'page_image',
      page_id: pageId,
      status: 'failed',
      error: lastError,
    });
    return { png: encodeSolidPng(size.width, size.height, PLACEHOLDER_RGB), real: false, error: lastError };
  }

  /** 旁白随视频阶段逐页自动合成：该页台词按 segments 逐段 TTS（分角色配音），
   * 段间加停顿拼成 narration.wav，导出时混入片段。
   * 单段失败先回退旁白音色重试一次；整页合成失败只跳过该页语音（发 failed 事件供前端提示），不阻塞成片。 */
  private async ensureNarration(
    bookId: string,
    lang: Lang,
    story: Story,
    page: Story['pages'][number],
    manifest: PageAssets,
  ): Promise<void> {
    const provider = this.providers.tts;
    if (!provider || manifest.narration_url) return;
    this.hub.publish(bookId, {
      bookId,
      type: 'page_narration',
      page_id: page.page_id,
      status: 'generating',
    });
    try {
      // 兜底修复：AI 分段可能漏掉对白之间的旁白过渡句，按 narration 逐字补回
      const segments = repairSegments(page.narration, page.segments);
      const narratorVoice = normalizeVoice(story.narrator_voice);
      const voiceOf = (speaker: string): string | undefined =>
        speaker === NARRATOR ? narratorVoice : normalizeVoice(story.characters.find((c) => c.name === speaker)?.voice);

      const audios: Uint8Array[] = [];
      for (const seg of segments) {
        const voice = voiceOf(seg.speaker);
        try {
          const { audio } = await provider.synthesize({ text: seg.text, lang, voice });
          audios.push(audio);
        } catch (err) {
          // 角色音色合成失败：回退默认旁白音色再试一次
          if (voice === undefined) throw err;
          const { audio } = await provider.synthesize({ text: seg.text, lang });
          audios.push(audio);
        }
      }
      // 多段时拼接（段间 250ms 停顿）；单段直接落盘，行为与旧版一致
      const wav = audios.length === 1 ? audios[0]! : concatWavs(audios, 250);
      this.assets.writePageBinary(bookId, page.page_id, 'narration.wav', wav);

      const wavPath = this.assets.rootPath('books', bookId, 'pages', page.page_id, 'narration.wav');
      const durationMs = await (this.config.probeDurationMs ?? probeDurationMs)(wavPath);
      manifest.narration_url = this.assets.pageUrl(bookId, page.page_id, 'narration.wav');
      manifest.narration_duration_ms = durationMs;
      this.assets.writePageAssets(bookId, page.page_id, manifest);
      this.hub.publish(bookId, {
        bookId,
        type: 'page_narration',
        page_id: page.page_id,
        status: 'ready',
      });
    } catch (err) {
      this.hub.publish(bookId, {
        bookId,
        type: 'page_narration',
        page_id: page.page_id,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 片头旁白：用默认旁白音色只念封面大标题（单段，无角色分声）。
   * 单页失败只跳过语音（发 failed 事件），不阻塞成片。 */
  private async ensureTitleNarration(bookId: string, lang: Lang, story: Story, manifest?: PageAssets): Promise<void> {
    const provider = this.providers.tts;
    if (!provider || !story.cover) return;
    const titleManifest = manifest ?? this.assets.tryReadPageAssets(bookId, TITLE_PAGE_ID);
    if (!titleManifest || titleManifest.narration_url) return;
    this.hub.publish(bookId, {
      bookId,
      type: 'page_narration',
      page_id: TITLE_PAGE_ID,
      status: 'generating',
    });
    try {
      const { audio } = await provider.synthesize({
        text: coverNarrationText(story),
        lang,
        voice: normalizeVoice(story.narrator_voice),
      });
      this.assets.writePageBinary(bookId, TITLE_PAGE_ID, 'narration.wav', audio);
      const wavPath = this.assets.rootPath('books', bookId, 'pages', TITLE_PAGE_ID, 'narration.wav');
      const durationMs = await (this.config.probeDurationMs ?? probeDurationMs)(wavPath);
      titleManifest.narration_url = this.assets.pageUrl(bookId, TITLE_PAGE_ID, 'narration.wav');
      titleManifest.narration_duration_ms = durationMs;
      this.assets.writePageAssets(bookId, TITLE_PAGE_ID, titleManifest);
      this.hub.publish(bookId, {
        bookId,
        type: 'page_narration',
        page_id: TITLE_PAGE_ID,
        status: 'ready',
      });
    } catch (err) {
      this.hub.publish(bookId, {
        bookId,
        type: 'page_narration',
        page_id: TITLE_PAGE_ID,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 渲染（或重渲染）某页 canvas 片段并回写清单；旁白字段不受影响 */
  private async renderCanvasClip(
    bookId: string,
    pageId: string,
    sceneSpec: SceneSpec,
    manifest: PageAssets,
  ): Promise<void> {
    const { durationMs } = await this.clipSource.generateClip({ bookId, pageId, sceneSpec });
    const clipUrl = this.assets.pageUrl(bookId, pageId, 'clip.mp4');
    manifest.clip_url = clipUrl;
    manifest.clip_duration_ms = durationMs;
    this.assets.writePageAssets(bookId, pageId, manifest);
    this.hub.publish(bookId, { bookId, type: 'page_clip', page_id: pageId, status: 'ready' });
  }

  /**
   * 文案编辑（用户在预览页改旁白/片头标题后触发）：更新 story 文本 →
   * 重配该页语音 → 重渲染该页片段（字幕烧在画面里）→ 重建 specs → 作废旧成片。
   * 插画与 seed 不动（不重画）。
   */
  async editPageText(
    bookId: string,
    pageId: string,
    patch: { narration?: string; cover?: { title?: string; subtitle?: string; tags?: string[] } },
  ): Promise<void> {
    const record = this.repo.get(bookId);
    if (!record) throw new Error(`book not found: ${bookId}`);
    if (record.state !== 'ready') throw new Error('book not ready');
    const lang = record.langs[0]!;
    const story = this.assets.readStory(bookId, lang);
    const size = bookPageSize(record, this.config.pageSize);

    if (pageId === TITLE_PAGE_ID) {
      if (!story.cover || !patch.cover) throw new Error(`cover text not editable: ${bookId}`);
      story.cover = { ...story.cover, ...patch.cover };
      this.assets.writeStory(bookId, lang, story);
      const manifest = this.assets.tryReadPageAssets(bookId, TITLE_PAGE_ID);
      if (!manifest) throw new Error(`page assets not found: ${TITLE_PAGE_ID}`);
      manifest.narration_url = undefined;
      manifest.narration_duration_ms = undefined;
      this.assets.writePageAssets(bookId, TITLE_PAGE_ID, manifest);
      await this.ensureTitleNarration(bookId, lang, story, manifest);
      await this.renderCanvasClip(
        bookId,
        TITLE_PAGE_ID,
        buildTitleSceneSpec({ story, size, assets: manifest }),
        manifest,
      );
    } else {
      const page = story.pages.find((p) => p.page_id === pageId);
      if (!page || !patch.narration) throw new Error(`page not found: ${pageId}`);
      page.narration = patch.narration;
      // 手改文本与角色分段无法自动对齐：重置为单旁白段（重配走旁白音色）
      page.segments = undefined;
      this.assets.writeStory(bookId, lang, story);
      const manifest = this.assets.tryReadPageAssets(bookId, pageId);
      if (!manifest) throw new Error(`page assets not found: ${pageId}`);
      manifest.narration_url = undefined;
      manifest.narration_duration_ms = undefined;
      this.assets.writePageAssets(bookId, pageId, manifest);
      await this.ensureNarration(bookId, lang, story, page, manifest);
      await this.renderCanvasClip(
        bookId,
        pageId,
        buildSceneSpec({ page, lang, style: record.style, size, assets: manifest }),
        manifest,
      );
    }

    this.rebuildBookSpecs(bookId, record);
    // 旁白/字幕已变，旧成片过期：清空导出产物回到 ready
    this.repo.update({ ...this.repo.get(bookId)!, state: 'ready', exports: undefined, updated_at: Date.now() });
    this.hub.publish(bookId, { bookId, type: 'state', state: 'ready' });
  }

  /** 重新配音：作废各页已合成的旁白，按（修复后的）segments 逐段重新 TTS。
   * 用于分段规则升级后让旧书补齐漏读的旁白过渡句，不重渲染插画/片段。
   * 旁白变化会使旧成片过期，故回到 ready 并清空导出产物供重新导出。 */
  async redubNarration(bookId: string): Promise<void> {
    const record = this.repo.get(bookId);
    if (!record) throw new Error(`book not found: ${bookId}`);
    this.repo.update({ ...record, state: 'ready', exports: undefined, updated_at: Date.now() });
    const lang = record.langs[0]!;
    const story = this.assets.readStory(bookId, lang);
    // 片头旁白一并重配
    const titleManifest = this.assets.tryReadPageAssets(bookId, TITLE_PAGE_ID);
    if (titleManifest?.narration_url) {
      titleManifest.narration_url = undefined;
      titleManifest.narration_duration_ms = undefined;
      this.assets.writePageAssets(bookId, TITLE_PAGE_ID, titleManifest);
    }
    await this.ensureTitleNarration(bookId, lang, story);
    for (const page of story.pages) {
      const manifest = this.assets.tryReadPageAssets(bookId, page.page_id);
      if (!manifest) continue;
      manifest.narration_url = undefined;
      manifest.narration_duration_ms = undefined;
      this.assets.writePageAssets(bookId, page.page_id, manifest);
      await this.ensureNarration(bookId, lang, story, page, manifest);
    }
    this.hub.publish(bookId, { bookId, type: 'state', state: 'ready' });
  }

  async regeneratePage(bookId: string, pageId: string): Promise<void> {
    const record = this.repo.get(bookId);
    if (!record) throw new Error(`book not found: ${bookId}`);
    if (record.state !== 'ready') throw new Error('book not ready');
    const used = record.counters.pageRegens[pageId] ?? 0;
    if (used >= MAX_PAGE_REGENS) throw new Error('page regen limit reached');

    this.repo.update({
      ...record,
      counters: { ...record.counters, pageRegens: { ...record.counters.pageRegens, [pageId]: used + 1 } },
      updated_at: Date.now(),
    });

    const story = this.assets.readStory(bookId, record.langs[0]!);
    const size = bookPageSize(record, this.config.pageSize);

    // 片头封面重画：换 seed 重生成封面插画并重建片头片段
    if (pageId === TITLE_PAGE_ID) {
      if (!story.cover) throw new Error('book has no cover');
      await this.ensureCoverAssets(bookId, story, true);
      const titleManifest = this.assets.tryReadPageAssets(bookId, TITLE_PAGE_ID)!;
      const { durationMs } = await this.clipSource.generateClip({
        bookId,
        pageId: TITLE_PAGE_ID,
        sceneSpec: buildTitleSceneSpec({
          story,
          size,
          assets: titleManifest,
        }),
      });
      const titleClipUrl = this.assets.pageUrl(bookId, TITLE_PAGE_ID, 'clip.mp4');
      titleManifest.clip_url = titleClipUrl;
      titleManifest.clip_duration_ms = durationMs;
      this.assets.writePageAssets(bookId, TITLE_PAGE_ID, titleManifest);
      this.rebuildBookSpecs(bookId, record);
      this.hub.publish(bookId, { bookId, type: 'state', state: 'ready' });
      return;
    }

    const pageIndex = story.pages.findIndex((p) => p.page_id === pageId);
    if (pageIndex < 0) throw new Error(`page not found: ${pageId}`);
    const rebuilt = await this.buildPageAssets(bookId, story, pageId, pageIndex);
    // 旁白文本来自 story（与插画无关），重画后保留已合成的语音
    const previous = this.assets.tryReadPageAssets(bookId, pageId);
    rebuilt.narration_url = previous?.narration_url;
    rebuilt.narration_duration_ms = previous?.narration_duration_ms;

    // 图已换新，同步重建该页 canvas 片段
    const page = story.pages[pageIndex]!;
    const { durationMs } = await this.clipSource.generateClip({
      bookId,
      pageId,
      sceneSpec: buildSceneSpec({
        page,
        lang: record.langs[0]!,
        style: record.style,
        size,
        assets: rebuilt,
      }),
    });
    const clipUrl = this.assets.pageUrl(bookId, pageId, 'clip.mp4');
    rebuilt.clip_url = clipUrl;
    rebuilt.clip_duration_ms = durationMs;

    this.assets.writePageAssets(bookId, pageId, rebuilt);

    this.rebuildBookSpecs(bookId, record);
    this.hub.publish(bookId, { bookId, type: 'state', state: 'ready' });
  }

  /** 按各语言 story 与磁盘清单（含片头）重建 book_specs */
  private rebuildBookSpecs(bookId: string, record: BookRecord): void {
    const size = bookPageSize(record, this.config.pageSize);
    for (const lang of record.langs) {
      const story = this.assets.readStory(bookId, lang);
      const spec = buildBookSpec({
        bookId,
        story,
        lang,
        style: record.style,
        size,
        pageAssets: this.collectPageAssets(bookId, story),
      });
      this.assets.writeBookSpec(bookId, lang, spec);
    }
  }
}
