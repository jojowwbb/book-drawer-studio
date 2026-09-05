import { z } from 'zod';

export const EMOTIONS = ['calm', 'joyful', 'tense', 'sad', 'wonder', 'sleepy'] as const;

export const StoryCharacterSchema = z.object({
  name: z.string().min(1),
  appearance_desc: z.string().min(1),
  /** 配音音色 id（见 voices.ts 音色板）；缺省或非法时回退默认音色 */
  voice: z.string().optional(),
});

/** 旁白分句：一段话由一个说话人朗读（「旁白」或角色名），用于分角色配音 */
export const NarrationSegmentSchema = z.object({
  speaker: z.string().min(1),
  text: z.string().min(1),
});

export const FxHintsSchema = z.object({
  camera: z.string().optional(),
  subjects: z.array(z.string()).default([]),
  ambient: z.string().optional(),
});

/** 可拟音的音效类型（雨/风等环境声由 fx_hints.ambient 派生，这里是有情节/情绪指向的动作声） */
export const SFX_TYPES = [
  // 动作/环境类
  'laugh',
  'cry',
  'footsteps',
  'door',
  'knock',
  'bell',
  'thunder',
  'birds',
  'water',
  // 情绪类
  'giggle', // 咯咯偷笑
  'applause', // 鼓掌
  'cheer', // 欢呼
  'gasp', // 惊讶倒吸气
  'sigh', // 叹气
  'magic', // 魔法闪光
  'whoosh', // 呼啸转场
  'heartbeat', // 心跳（紧张）
  'yawn', // 打哈欠（困倦）
  'snore', // 呼噜（安睡）
  // 动物叫（绘本主角多为小动物）
  'cat', // 猫叫
  'dog', // 狗汪汪
  'rooster', // 公鸡打鸣
  'duck', // 鸭子嘎嘎
  'frog', // 青蛙呱呱
  'cow', // 奶牛哞哞
  // 自然与物件
  'waves', // 海浪
  'fire', // 篝火噼啪
  'clock', // 时钟滴答
  'phone', // 电话铃
  'balloon', // 气球爆
  'page_turn', // 翻书页
  // 情节渲染
  'drum_roll', // 鼓点悬念
  'fanfare', // 胜利号角
] as const;
export type SfxType = (typeof SFX_TYPES)[number];

/** 单条音效提示：type=音效种类，at=对应词语在旁白文稿中的位置比例（0-1，导出时换算为实际发声时刻；缺省视为旁白中段） */
export const SfxCueSchema = z.object({
  type: z.enum(SFX_TYPES),
  at: z.number().min(0).max(1).optional(),
});
export type SfxCue = z.infer<typeof SfxCueSchema>;

/**
 * 音效 cue 列表：LLM 常幻觉出枚举外的类型（如 shout/growl），音效只是导出混音的
 * 点缀，不应拖垮整本 parse——预处理逐条丢弃未知类型，合法 cue 保留。
 */
export const SfxCueListSchema = z.preprocess(
  (val) =>
    Array.isArray(val)
      ? val.filter(
          (c) =>
            c !== null &&
            typeof c === 'object' &&
            (SFX_TYPES as readonly string[]).includes((c as { type?: unknown }).type as string),
        )
      : val,
  z.array(SfxCueSchema).optional(),
);

/** 片头封面（爆款封面）：AI 依主题生成吸睛标题、标签与封面插画描述，渲染时前置为片头幕 */
export const StoryCoverSchema = z.object({
  /** 片头大标题（爆款钩子，可不同于书名） */
  title: z.string().min(1),
  /** 副标题/一句话钩子（可选） */
  subtitle: z.string().optional(),
  /** 内容标签（如 #睡前故事 #成语），3-5 个 */
  tags: z.array(z.string().min(1)).default([]),
  /** 封面插画的文生图描述（16:9，画面不含文字，标题由渲染层叠加） */
  cover_prompt: z.string().min(1),
});

export const StoryPageSchema = z.object({
  page_id: z.string().min(1),
  page_text: z.string().min(1),
  narration: z.string().min(1),
  /** 旁白按说话人分段（分角色配音）；缺省视为单段旁白（旧书兼容） */
  segments: z.array(NarrationSegmentSchema).optional(),
  scene_desc: z.string().min(1),
  characters: z.array(z.string()).default([]),
  emotion: z.enum(EMOTIONS),
  is_climax: z.boolean().default(false),
  fx_hints: FxHintsSchema.optional(),
  /** 旁白情节音效（笑声/脚步/雷声等，由文案生成阶段分析 narration 得出）；缺省无音效 */
  sfx: SfxCueListSchema,
});

export const StorySchema = z.object({
  title: z.string().min(1),
  age_hint: z.string().default('3-6'),
  style_anchor: z.string().min(1),
  lang: z.enum(['zh', 'en']),
  /** 片头封面（缺省时不生成片头幕，旧书兼容） */
  cover: StoryCoverSchema.optional(),
  characters: z.array(StoryCharacterSchema).min(1),
  /** 旁白配音音色（缺省走供应商全局默认音色）；音色确认阶段可手动改配 */
  narrator_voice: z.string().optional(),
  // 上限 30：短句主题通常 3-14 幕即可讲完，整篇长文需要更多幕次从容铺展情节
  pages: z.array(StoryPageSchema).min(3).max(30),
});

export type Emotion = (typeof EMOTIONS)[number];
export type StoryCharacter = z.infer<typeof StoryCharacterSchema>;
export type NarrationSegment = z.infer<typeof NarrationSegmentSchema>;
export type FxHints = z.infer<typeof FxHintsSchema>;
export type StoryCover = z.infer<typeof StoryCoverSchema>;
export type StoryPage = z.infer<typeof StoryPageSchema>;
export type Story = z.infer<typeof StorySchema>;
