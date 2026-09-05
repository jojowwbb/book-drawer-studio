import { existsSync, readFileSync } from 'node:fs';
import { BookSpecSchema } from '@pb/renderer';
import type { Lang } from '@pb/ai-core';
import type { AssetStore } from '../asset-store';
import type { ExportArtifact } from '../book-repo';
import { ensureCanonPianoWav } from './bgm';
import { probeHasAudio } from './ffmpeg';
import { DEFAULT_TRANSITION_MS, NARRATION_LEAD_MS, NARRATION_TAIL_MS, joinClips } from './clip-join';
import type { JoinDeps, JoinPart } from './clip-join';

export interface ConcatExporterDeps {
  assets: AssetStore;
  ffmpegBin?: string;
  /** 音频流探测（默认 ffprobe）；测试可注入桩 */
  probeHasAudio?: (path: string) => Promise<boolean>;
  /** 重编码拼接时的目标帧率 */
  fps?: number;
  /** 幕间交叉溶解时长（ms）；0 关闭转场回到硬切拼接 */
  transitionMs?: number;
  /** 背景音乐文件路径；undefined 用内置卡农钢琴版，null 关闭 BGM */
  bgmPath?: string | null;
  /** BGM 相对音量（旁白保持原音量），默认 0.12 */
  bgmVolume?: number;
  /** 环境音效层（从每页视觉氛围派生）；默认开启，PB_SFX=off 关闭 */
  sfx?: boolean;
}

/**
 * 绘本导出器：读 BookSpec + 页资产清单 → 组 JoinPart[] → 交给公共核 joinClips
 * （归一化混音/转场拼接/BGM/音效逻辑在 export/clip-join.ts，与故事视频产线共用）。
 */
export class ConcatExporter {
  constructor(private readonly deps: ConcatExporterDeps) {}

  async exportBook(bookId: string, lang: Lang): Promise<ExportArtifact> {
    const { assets } = this.deps;
    const probeAudio = this.deps.probeHasAudio ?? probeHasAudio;
    const spec = BookSpecSchema.parse(
      JSON.parse(readFileSync(assets.rootPath('books', bookId, 'book_specs', `${lang}.json`), 'utf8')),
    );

    const parts: JoinPart[] = [];
    for (const page of spec.pages) {
      const manifest = assets.tryReadPageAssets(bookId, page.page_id);
      const clipPath = manifest?.clip_url
        ? assets.rootPath('books', bookId, manifest.clip_url.replace(`/assets/books/${bookId}/`, ''))
        : undefined;
      if (!clipPath || !existsSync(clipPath)) {
        throw new Error(`clip missing for page ${page.page_id}`);
      }
      const clipMs = manifest?.clip_duration_ms ?? page.duration_ms;
      const narrationPath = manifest?.narration_url
        ? assets.rootPath('books', bookId, manifest.narration_url.replace(`/assets/books/${bookId}/`, ''))
        : undefined;
      const hasNarration = !!narrationPath && existsSync(narrationPath);
      // 旁白需要占用的画面时长：起播延迟 + 语音时长 + 收尾留白
      const narrationMs =
        hasNarration && manifest?.narration_duration_ms
          ? NARRATION_LEAD_MS + manifest.narration_duration_ms + NARRATION_TAIL_MS
          : undefined;
      const clipHasAudio = await probeAudio(clipPath);
      parts.push({
        clipPath,
        clipMs,
        narrationPath: hasNarration ? narrationPath : undefined,
        narrationMs,
        narrationVoiceMs: hasNarration ? manifest?.narration_duration_ms : undefined,
        clipHasAudio,
        ambient: page.ambient.map((a) => a.type),
        cues: page.sfx,
      });
    }

    const joinDeps: JoinDeps = {
      ffmpegBin: this.deps.ffmpegBin,
      fps: this.deps.fps,
      transitionMs: this.deps.transitionMs ?? DEFAULT_TRANSITION_MS,
      bgmVolume: this.deps.bgmVolume,
      sfx: this.deps.sfx,
    };
    const outPath = assets.rootPath('books', bookId, `exports/${lang}.mp4`);
    // 每本书可关闭 BGM（创建页开关）：bgm=false 时成片不混背景音乐
    const bgmOff = assets.tryReadBookRecord(bookId)?.bgm === false;
    const { totalMs, sizeBytes } = await joinClips(joinDeps, parts, spec.pages[0]!, outPath, {
      tag: lang,
      bgmPath: this.bgmFile(bgmOff),
    });

    return {
      url: assets.exportUrl(bookId, lang),
      duration_ms: totalMs,
      size_bytes: sizeBytes,
    };
  }

  /** 解析 BGM 文件路径；返回 undefined 表示关闭（本书开关关闭或 bgmPath: null） */
  private bgmFile(bgmOff = false): string | undefined {
    if (bgmOff || this.deps.bgmPath === null) return undefined;
    if (this.deps.bgmPath) return this.deps.bgmPath;
    return ensureCanonPianoWav(this.deps.assets.rootPath('bgm', 'canon-piano.wav'));
  }
}
