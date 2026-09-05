import { z } from 'zod';

export const CAMERA_TYPES = [
  'ken_burns_in',
  'ken_burns_out',
  'pan_left',
  'pan_right',
  'static_breath',
] as const;

export const SUBJECT_FX_TYPES = [
  'breathe',
  'sway',
  'float',
  'enter_left',
  'enter_right',
] as const;

export const AMBIENT_TYPES = [
  'stars_twinkle',
  'clouds_drift',
  'fireflies',
  'snow',
  'rain',
  'light_rays',
] as const;

export const SubjectSpecSchema = z.object({
  src: z.string().min(1),
  x: z.number(),
  y: z.number(),
  scale: z.number().positive().default(1),
  fx: z.array(z.enum(SUBJECT_FX_TYPES)).default([]),
});

export const AmbientSpecSchema = z.object({
  type: z.enum(AMBIENT_TYPES),
  density: z.number().min(0).max(1).default(0.5),
});

/** 情节音效（由文案生成阶段分析旁白得出）：type=音效种类，at=对应词语在旁白文稿中的位置比例（0-1）。渲染层忽略，导出混音使用 */
export const SFX_CUE_TYPES = [
  'laugh',
  'cry',
  'footsteps',
  'door',
  'knock',
  'bell',
  'thunder',
  'birds',
  'water',
  'giggle',
  'applause',
  'cheer',
  'gasp',
  'sigh',
  'magic',
  'whoosh',
  'heartbeat',
  'yawn',
  'snore',
  'cat',
  'dog',
  'rooster',
  'duck',
  'frog',
  'cow',
  'waves',
  'fire',
  'clock',
  'phone',
  'balloon',
  'page_turn',
  'drum_roll',
  'fanfare',
] as const;

export const SfxCueSpecSchema = z.object({
  type: z.enum(SFX_CUE_TYPES),
  at: z.number().min(0).max(1).default(0.5),
});

/** 片头幕的文字叠加层：爆款标题 + 标签胶囊，由渲染层绘制在封面插画之上 */
export const TitleOverlaySchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  tags: z.array(z.string().min(1)).default([]),
});

export const SceneSpecSchema = z.object({
  page_id: z.string().min(1),
  duration_ms: z.number().int().positive(),
  width: z.number().int().positive().default(1920),
  height: z.number().int().positive().default(1080),
  seed: z.number().int().default(0),
  base_color: z.string().default('#101828'),
  background: z.object({ src: z.string().min(1) }),
  subjects: z.array(SubjectSpecSchema).default([]),
  foreground: z.object({ src: z.string().min(1) }).optional(),
  camera: z.object({
    type: z.enum(CAMERA_TYPES),
    intensity: z.number().min(0).max(1).default(0.5),
  }),
  ambient: z.array(AmbientSpecSchema).default([]),
  /** 情节音效（导出混音用；渲染层忽略） */
  sfx: z.array(SfxCueSpecSchema).default([]),
  video_ref: z.string().optional(),
  subtitle: z.object({ text: z.string() }).optional(),
  /** 片头幕叠加层（有值时该幕渲染为大标题 + 标签胶囊，不渲染普通字幕） */
  title_overlay: TitleOverlaySchema.optional(),
  audio_refs: z
    .object({ narration: z.string().optional(), bgm: z.string().optional() })
    .optional(),
});

export const BookSpecSchema = z.object({
  id: z.string().min(1),
  pages: z.array(SceneSpecSchema).min(1),
  crossfade_ms: z.number().int().nonnegative().default(600),
});

export type CameraType = (typeof CAMERA_TYPES)[number];
export type SubjectFxType = (typeof SUBJECT_FX_TYPES)[number];
export type AmbientType = (typeof AMBIENT_TYPES)[number];
export type SubjectSpec = z.infer<typeof SubjectSpecSchema>;
export type AmbientSpec = z.infer<typeof AmbientSpecSchema>;
export type SfxCueType = (typeof SFX_CUE_TYPES)[number];
export type SfxCueSpec = z.infer<typeof SfxCueSpecSchema>;
export type TitleOverlay = z.infer<typeof TitleOverlaySchema>;
export type SceneSpec = z.infer<typeof SceneSpecSchema>;
export type BookSpec = z.infer<typeof BookSpecSchema>;
export type Size = { width: number; height: number };
