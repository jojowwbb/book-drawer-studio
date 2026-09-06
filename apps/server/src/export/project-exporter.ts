import { existsSync } from 'node:fs';
import type { AssetStore } from '../asset-store';
import type { ProjectRepo } from '../project-repo';
import type { ExportArtifact } from '../book-repo';
import { ensureCanonPianoWav } from './bgm';
import { probeDurationMs, probeHasAudio } from './ffmpeg';
import { DEFAULT_TRANSITION_MS, NARRATION_LEAD_MS, NARRATION_TAIL_MS, joinClips } from './clip-join';
import type { JoinDeps, JoinPart, TransitionType } from './clip-join';

export interface ProjectExporterDeps {
  assets: AssetStore;
  repo: ProjectRepo;
  ffmpegBin?: string;
  /** 音频流探测（默认 ffprobe）；测试可注入桩 */
  probeHasAudio?: (path: string) => Promise<boolean>;
  /** 片段时长探测（默认 ffprobe）；测试可注入桩 */
  probeDurationMs?: (path: string) => Promise<number>;
  fps?: number;
  /** 横版成片分辨率（缺省 1920×1080）；竖版固定 1080×1920 */
  pageSize?: { width: number; height: number };
  /** 幕间转场时长（ms）；0 关闭转场回到硬切拼接 */
  transitionMs?: number;
  /** 转场类型（翻页感 slideleft / 交叉溶解 fade 等）；缺省见 DEFAULT_TRANSITION_TYPE */
  transition?: TransitionType;
  /** 背景音乐文件路径；undefined 用内置卡农钢琴版，null 关闭 BGM */
  bgmPath?: string | null;
  bgmVolume?: number;
  /** 音效层开关；默认开启 */
  sfx?: boolean;
}

/**
 * 故事视频导出器：读 script.json + SceneManifest → 组 JoinPart[] → 交给公共核 joinClips。
 * 与绘本 ConcatExporter 平行（拼接/混音/BGM 逻辑全在 clip-join.ts）；
 * clip_failed 或关键帧失败的场次跳过（管线阶段已标记，导出端只兜底查文件存在性）。
 */
export class ProjectExporter {
  constructor(private readonly deps: ProjectExporterDeps) {}

  async exportProject(projectId: string): Promise<ExportArtifact> {
    const { assets } = this.deps;
    const record = this.deps.repo.get(projectId);
    if (!record) throw new Error(`project not found: ${projectId}`);
    const script = assets.readScript(projectId);
    const probeAudio = this.deps.probeHasAudio ?? probeHasAudio;
    const probeDur = this.deps.probeDurationMs ?? probeDurationMs;

    const sceneById = new Map(script.episodes.flatMap((e) => e.scenes).map((s) => [s.id, s]));
    const parts: JoinPart[] = [];
    for (const m of record.scenes) {
      const clipPath = m.clip_url
        ? assets.rootPath('projects', projectId, m.clip_url.replace(`/assets/projects/${projectId}/`, ''))
        : undefined;
      if (!clipPath || !existsSync(clipPath)) continue; // 失败场跳过
      const clipMs = m.clip_duration_ms ?? (await probeDur(clipPath));
      const narrationPath = m.narration_url
        ? assets.rootPath('projects', projectId, m.narration_url.replace(`/assets/projects/${projectId}/`, ''))
        : undefined;
      const hasNarration = !!narrationPath && existsSync(narrationPath);
      const narrationMs =
        hasNarration && m.narration_duration_ms
          ? NARRATION_LEAD_MS + m.narration_duration_ms + NARRATION_TAIL_MS
          : undefined;
      const scene = sceneById.get(m.scene_id);
      parts.push({
        clipPath,
        clipMs,
        narrationPath: hasNarration ? narrationPath : undefined,
        narrationMs,
        narrationVoiceMs: hasNarration ? m.narration_duration_ms : undefined,
        clipHasAudio: await probeAudio(clipPath),
        // ai-core 的 at 带 zod 默认值（可选），joinClips 需要已解析的必选字段
        cues: scene?.sfx?.map((c) => ({ type: c.type, at: c.at ?? 0.5 })),
      });
    }
    if (parts.length === 0) throw new Error('no scene clips available to export');

    const size =
      record.format === 'portrait'
        ? { width: 1080, height: 1920 }
        : this.deps.pageSize ?? { width: 1920, height: 1080 };
    const joinDeps: JoinDeps = {
      ffmpegBin: this.deps.ffmpegBin,
      fps: this.deps.fps,
      transitionMs: this.deps.transitionMs ?? DEFAULT_TRANSITION_MS,
      // 故事视频是连续剧情而非翻页，默认保持交叉溶解
      transition: this.deps.transition ?? 'fade',
      bgmVolume: this.deps.bgmVolume,
      sfx: this.deps.sfx,
    };
    const outPath = assets.rootPath('projects', projectId, 'exports/final.mp4');
    const { totalMs, sizeBytes } = await joinClips(joinDeps, parts, size, outPath, {
      tag: 'final',
      bgmPath: this.bgmFile(),
    });

    return { url: assets.projectExportUrl(projectId), duration_ms: totalMs, size_bytes: sizeBytes };
  }

  /** 解析 BGM 文件路径；返回 undefined 表示关闭（bgmPath: null） */
  private bgmFile(): string | undefined {
    if (this.deps.bgmPath === null) return undefined;
    if (this.deps.bgmPath) return this.deps.bgmPath;
    return ensureCanonPianoWav(this.deps.assets.rootPath('bgm', 'canon-piano.wav'));
  }
}
