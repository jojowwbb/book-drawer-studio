import type { Story } from './story-schema';
import type { ScriptAnalysis } from './script-schema';

export type Lang = 'zh' | 'en';
export type StyleId =
  | 'watercolor'
  | 'flat'
  | 'cartoon'
  | 'crayon'
  | 'anime'
  | 'chibi'
  | 'ghibli'
  | 'colored-pencil'
  | 'collage'
  | 'gouache'
  // 故事视频产线专用风格预设（绘本产线不展示）
  | 'realistic-3d'
  | 'fantasy-picturebook'
  | 'inkwash';

export interface StoryRequest {
  theme: string;
  style: StyleId;
  lang: Lang;
  /** 用户指定的书名：定稿后强制覆盖 title 与片头大标题（cover.title），AI 仍据此创作 */
  title?: string;
  /** 画幅：landscape=横版16:9（默认），portrait=竖版9:16；影响场景构图描述 */
  format?: 'landscape' | 'portrait';
  /** 指定则严格按该页数分幕；缺省由 AI 按内容量自适应分幕（3-30 页） */
  page_count?: number;
  reject_reason?: string;
}

export interface StoryProvider {
  readonly name: string;
  generateStory(req: StoryRequest): Promise<Story>;
}

/** 故事视频产线：主题文章 → 剧本分析（分集分场 + 角色设定卡） */
export interface ScriptRequest {
  /** 主题或整篇文章原文（1-10000 字） */
  source: string;
  style: StyleId;
  lang: Lang;
  /** 用户指定作品名：定稿后服务端强制覆盖 title */
  title?: string;
  format?: 'landscape' | 'portrait';
  /** 指定集数（1-3）；缺省由 AI 按内容量决定 */
  episode_count?: number;
  reject_reason?: string;
}

export interface ScriptProvider {
  readonly name: string;
  analyzeScript(req: ScriptRequest): Promise<ScriptAnalysis>;
}

export interface ImageRequest {
  prompt: string;
  style: StyleId;
  width: number;
  height: number;
  seed: number;
}

export interface ImageProvider {
  readonly name: string;
  generateImage(req: ImageRequest): Promise<Uint8Array>; // PNG bytes
}

export interface MatteResult {
  background: Uint8Array;
  subjects: Uint8Array[];
  foreground?: Uint8Array;
}

export interface MattingProvider {
  readonly name: string;
  matte(fullImagePng: Uint8Array, seed: number): Promise<MatteResult>;
}

/** r2v 成片画幅（wan2.7-r2v parameters.ratio） */
export type VideoRatio = '16:9' | '9:16' | '1:1' | '4:3' | '3:4';

export interface VideoClipRequest {
  /** i2v 模式：首帧插画 PNG 字节（与 referenceImages 二选一） */
  firstFramePng?: Uint8Array;
  /** 尾帧插画 PNG 字节；缺省时复用首帧（画面从插画出发再回到插画） */
  lastFramePng?: Uint8Array;
  /**
   * r2v 模式（参考图生视频）：参考图 PNG 字节，1-5 张。
   * 数组顺序 = media 中 reference_image 顺序 = prompt「图N」编号，必须同源产出。
   * 非空时走 r2v 分支（忽略 firstFramePng）。
   */
  referenceImages?: Uint8Array[];
  /** r2v 成片画幅；由调用方按项目 format 推出，缺省 16:9 */
  ratio?: VideoRatio;
  /** 生成描述（场景 + 动作 + 运动提示） */
  prompt: string;
  /** 期望时长秒数，默认 5 */
  durationSec?: number;
  resolution?: '720P' | '1080P';
  seed?: number;
}

export interface VideoClipResult {
  video: Uint8Array; // mp4 bytes
}

export interface VideoGenProvider {
  readonly name: string;
  generateClip(req: VideoClipRequest): Promise<VideoClipResult>;
}

export interface TtsRequest {
  /** 待合成文本（旁白台词） */
  text: string;
  /** 目标语言，影响发音与语调 */
  lang: Lang;
  /** 音色（供应商自定义标识） */
  voice?: string;
  /**
   * 本条语音的自然语言语气指令（如该页情绪的朗读语气），与供应商全局
   * 基调指令叠加下发；仅 instruct 系模型生效。
   */
  instructions?: string;
}

export interface TtsResult {
  /** 音频字节（wav） */
  audio: Uint8Array;
}

export interface TtsProvider {
  readonly name: string;
  synthesize(req: TtsRequest): Promise<TtsResult>;
}

export interface ModerationResult {
  verdict: 'pass' | 'reject';
  reason?: string;
}

export interface ModerationProvider {
  readonly name: string;
  checkText(text: string): Promise<ModerationResult>;
  checkImage(png: Uint8Array): Promise<ModerationResult>;
}

export interface ProviderBundle {
  story: StoryProvider;
  image: ImageProvider;
  matting: MattingProvider;
  /** 逐页旁白配音（用户手动触发）；Fake 测试桩可缺省 */
  tts?: TtsProvider;
  moderation: ModerationProvider;
}

/** 故事视频产线依赖的供应商集合（不经过 canvas 渲染，无需 story/matting） */
export interface ProjectProviders {
  script: ScriptProvider;
  image: ImageProvider;
  /** 逐场图生视频；Fake 测试桩可缺省 */
  videoClip?: VideoGenProvider;
  /** 对白/旁白配音；Fake 测试桩可缺省 */
  tts?: TtsProvider;
  moderation: ModerationProvider;
}
