import { z } from 'zod';
import { SfxCueListSchema } from './story-schema';

/**
 * 故事视频产线的剧本分析结构：主题文章/小说/剧本 → 分集分场 + 角色设定卡。
 * 与绘本 StorySchema 平行独立：不面向低幼、按「集/场」组织、角色带定制字段。
 */

export const ScriptCharacterSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** 外形描述（立绘与关键帧一致性的锚，定制环节可改） */
  appearance: z.string().min(1),
  costume: z.string().optional(),
  personality: z.string().min(1),
  /** 配音音色 id（见 voices.ts 音色板）；缺省回退默认音色 */
  voice: z.string().optional(),
});

/** 一句台词：speaker=角色名或「旁白」 */
export const ScriptDialogueSchema = z.object({
  speaker: z.string().min(1),
  line: z.string().min(1),
});

/**
 * 场景资产卡（与角色卡对称）：同一地点在所有场次共用一份逐字描述，
 * 关键帧与 i2v prompt 锚定它，防止 AI 每场幻觉出新的环境细节。
 */
export const ScriptLocationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** 环境描述（跨场一致性的锚）：空间结构、固定陈设、材质与色调，不含角色与瞬时光线 */
  description: z.string().min(1),
});

export const ScriptSceneSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  /** 本场剧情梗概（≤80 字） */
  synopsis: z.string().min(1),
  /** 对白（≤6 条，防超输出 token） */
  dialogues: z.array(ScriptDialogueSchema).max(6).default([]),
  /** 本场唯一地点（引用 locations[].id；未知引用在 parse 后归一化为 undefined） */
  location_id: z.string().optional(),
  /** 关键帧插画的文生图描述：主体动作+环境光影，角色用全名、环境不重复场景卡内容 */
  scene_prompt: z.string().min(1),
  /** 运镜描述（i2v 用）：镜头如何运动，如「从特写缓慢拉远并微微上仰」；缺省用默认缓推 */
  camera: z.string().max(60).optional(),
  /** 旁白叙述（可选，与对白一起进配音链） */
  narration: z.string().optional(),
  /** 情节音效 cues（沿用绘本产线音效类型；枚举外的幻觉类型逐条丢弃） */
  sfx: SfxCueListSchema,
});

export const ScriptEpisodeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  scenes: z.array(ScriptSceneSchema).min(1),
});

export const ScriptAnalysisSchema = z.object({
  title: z.string().min(1),
  logline: z.string().optional(),
  style_anchor: z.string().min(1),
  lang: z.enum(['zh', 'en']),
  characters: z.array(ScriptCharacterSchema).min(1).max(8),
  /** 场景资产卡（旧剧本可能没有，缺省无场景锚定） */
  locations: z.array(ScriptLocationSchema).max(12).default([]),
  episodes: z.array(ScriptEpisodeSchema).min(1).max(3),
}).refine(
  (a) => {
    const total = a.episodes.reduce((n, e) => n + e.scenes.length, 0);
    return total >= 3 && total <= 24;
  },
  { message: 'total scenes must be between 3 and 24' },
);

/**
 * 场景引用归一化：AI 幻觉出不存在的 location_id 时置空（回退无锚定），
 * 同场景 id 去重保留首个。在 provider parse 之后调用。
 */
export function normalizeScriptLocations(analysis: ScriptAnalysis): ScriptAnalysis {
  const seen = new Set<string>();
  const locations: ScriptLocation[] = [];
  for (const loc of analysis.locations) {
    if (seen.has(loc.id)) continue;
    seen.add(loc.id);
    locations.push(loc);
  }
  const valid = new Set(locations.map((l) => l.id));
  return {
    ...analysis,
    locations,
    episodes: analysis.episodes.map((ep) => ({
      ...ep,
      scenes: ep.scenes.map((sc) =>
        sc.location_id && !valid.has(sc.location_id) ? { ...sc, location_id: undefined } : sc,
      ),
    })),
  };
}

export type ScriptCharacter = z.infer<typeof ScriptCharacterSchema>;
export type ScriptDialogue = z.infer<typeof ScriptDialogueSchema>;
export type ScriptLocation = z.infer<typeof ScriptLocationSchema>;
export type ScriptScene = z.infer<typeof ScriptSceneSchema>;
export type ScriptEpisode = z.infer<typeof ScriptEpisodeSchema>;
export type ScriptAnalysis = z.infer<typeof ScriptAnalysisSchema>;
