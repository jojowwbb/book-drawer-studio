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

/**
 * 可拟音的音效类型（绘本专注儿童故事：全部素材走「软、萌、童趣」方向，
 * 避免真实哭声/爆裂声等易惊吓孩子的音色）。
 * 风声等纯氛围铺底由 fx_hints.ambient 派生，这里是带情节/情绪指向的动作声。
 */
export const SFX_TYPES = [
  // 情绪人声
  'giggle', // 咯咯偷笑
  'laugh', // 童声大笑
  'sniffle', // 轻轻抽泣（比真实哭声柔和）
  'gasp', // 惊喜「哇」
  'cheer', // 齐声欢呼「耶」
  'yawn', // 软绵哈欠（困倦）
  'snore', // 轻柔呼噜（安睡）
  // 可爱动作
  'tiptoe', // 踮脚轻步
  'scamper', // 小碎步哒哒跑
  'hop', // 弹跳 boing
  'splash', // 戏水啪嗒
  'whoosh', // 轻柔掠过/转场
  // 魔法幻想
  'sparkle', // 魔法星光
  'poof', // 噗——变身/突然出现
  'twinkle', // 星星风铃闪烁
  'music_box', // 八音盒旋律
  // 小动物（绘本主角多为幼崽，音色更奶更软）
  'kitten', // 奶猫软喵
  'puppy', // 小奶狗汪汪
  'duckling', // 小鸭嘎嘎
  'frog', // 小青蛙咕呱
  'owl', // 猫头鹰呜呜
  'birds', // 清晨鸟鸣
  'bee', // 小蜜蜂嗡嗡
  // 自然
  'rain', // 温柔雨滴
  'stream', // 林间溪流
  'waves', // 海浪
  'thunder', // 远处闷雷（弱化不吓人）
  // 物件
  'bell', // 小铃铛
  'knock', // 软软敲门
  'door', // 木门吱呀
  'clock', // 时钟滴答
  'page_turn', // 翻书页
  'balloon', // 气球放气（可爱，非爆裂）
  'fire', // 篝火噼啪
  // 情节渲染
  'drum_roll', // 玩具鼓点悬念
  'fanfare', // 俏皮胜利号角
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
