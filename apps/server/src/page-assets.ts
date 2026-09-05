export interface PageAssets {
  page_id: string;
  seed: number;
  image_url: string;
  background_url: string;
  subject_urls: string[];
  foreground_url?: string;
  /** 该页导出片段（clip.mp4，PixiJS headless 逐帧渲染的插画动画） */
  clip_url?: string;
  clip_duration_ms?: number;
  /** 用户逐页点击「生成旁白」产出的 TTS 配音（narration.wav），导出时混入片段 */
  narration_url?: string;
  narration_duration_ms?: number;
  /** 插画生成/审核多次失败后跳过：当前为占位图，可在预览页单独重画 */
  image_failed?: boolean;
  /** 跳过时的最后一次失败原因（供阶段失败信息与排查用） */
  image_error?: string;
}
