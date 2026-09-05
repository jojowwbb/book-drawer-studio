import type { ScriptAnalysis, ScriptLocation, ScriptScene } from '@pb/ai-core';
import type { CharacterCard, LocationCard } from './project-repo';

/** 按渲染尺寸取构图方向词（插画 prompt 用） */
function orientationHint(size: { width: number; height: number }): string {
  return size.width < size.height ? '竖版 9:16' : '横版 16:9';
}

/** 本场所属的场景资产卡（location_id 引用；未知/缺省引用返回 undefined） */
export function sceneLocation(script: ScriptAnalysis, scene: ScriptScene): ScriptLocation | undefined {
  if (!scene.location_id) return undefined;
  return script.locations.find((l) => l.id === scene.location_id);
}

/**
 * 角色立绘的文生图 prompt：画风锚 + 设定卡文案逐字在场（定制环节改的就是这些字段），
 * 纯色背景方便用户比对三版差异，无文字。
 */
export function buildPortraitPrompt(styleAnchor: string, card: CharacterCard): string {
  return [
    styleAnchor,
    `角色设定：${card.name}，${card.appearance}${card.costume ? `，穿着${card.costume}` : ''}，${card.personality}`,
    `${card.name}的全身立绘，正面自然站姿，纯色浅灰背景，${orientationHint({ width: 1080, height: 1080 })}方形构图，画面中不要出现任何文字`,
  ].join('。');
}

/** 该场出场的角色：对白说话人 + scene_prompt 里提到的全名（从定稿角色卡中筛） */
export function sceneCast(cast: CharacterCard[], scene: ScriptScene): CharacterCard[] {
  const speakers = new Set(scene.dialogues.map((d) => d.speaker));
  return cast.filter((c) => speakers.has(c.name) || scene.scene_prompt.includes(c.name));
}

/**
 * 场景图（r2v 环境参考图）的文生图 prompt：画风锚 + 场景卡描述逐字在场，
 * 硬性要求无人物空镜——混入角色会污染 r2v 的环境参考。
 */
export function buildLocationPrompt(
  styleAnchor: string,
  loc: LocationCard,
  size: { width: number; height: number },
): string {
  return [
    styleAnchor,
    `场景设定：${loc.name}，${loc.description}`,
    `${loc.name}的空镜头全景，画面中不出现任何人物、动物与角色，单一完整地点构图，${orientationHint(size)}，画面中不要出现任何文字`,
  ].join('。');
}

/** r2v 参考图上限（wan2.7-r2v：图+视频合计 ≤5） */
export const R2V_MAX_REFS = 5;

/**
 * 出场角色切分：media 参考图（≤cap）与仅文字描述。
 * 超限时有对白的说话人优先（口型要对着正确的脸），其余保持 cast 原顺序。
 */
export function selectR2vCast(
  cast: CharacterCard[],
  scene: ScriptScene,
  cap: number,
): { inMedia: CharacterCard[]; described: CharacterCard[] } {
  if (cast.length <= cap) return { inMedia: cast, described: [] };
  const speakers = new Set(scene.dialogues.map((d) => d.speaker));
  const priority = cast.filter((c) => speakers.has(c.name));
  const rest = cast.filter((c) => !speakers.has(c.name));
  const chosen = [...priority, ...rest].slice(0, cap);
  const chosenSet = new Set(chosen.map((c) => c.id));
  return {
    inMedia: cast.filter((c) => chosenSet.has(c.id)),
    described: cast.filter((c) => !chosenSet.has(c.id)),
  };
}

/** 进 r2v media 的一张角色参考图：定稿角色卡 + 选定立绘字节 */
export interface CastReference {
  card: CharacterCard;
  png: Uint8Array;
}

/**
 * r2v（参考图生视频）请求构建：referenceImages 数组与 prompt 的「图N」编号
 * 在此**同源产出**（顺序：场景图=图1，角色立绘按入参顺序=图2..N），杜绝编号错位。
 * prompt 沿用五段式：①参考图绑定+主体动作 ②口型约束 ③镜头运动 ④速度节奏 ⑤美学风格。
 * **旁白原文与台词文本绝不入 prompt**——旁白走 TTS，喂给模型会让它给角色编口型。
 */
export function buildR2vRequest(args: {
  script: ScriptAnalysis;
  scene: ScriptScene;
  /** 该场选定场景图（无场景卡/未选定时缺省，回退文字锚定） */
  locationImage?: { name: string; png: Uint8Array };
  /** 进 media 的角色立绘（已按上限截断） */
  castIn: CastReference[];
  /** 被挤掉的角色：只文字描述外形 */
  castOut: CharacterCard[];
}): { prompt: string; referenceImages: Uint8Array[] } {
  const { script, scene, locationImage, castIn, castOut } = args;
  const refs: { label: string; png: Uint8Array }[] = [];
  if (locationImage) refs.push({ label: `场景「${locationImage.name}」`, png: locationImage.png });
  for (const r of castIn) refs.push({ label: `角色「${r.card.name}」`, png: r.png });

  const bindings = refs.length > 0
    ? `${refs.map((r, i) => `图${i + 1}是${r.label}`).join('，')}。`
    : '';
  const loc = sceneLocation(script, scene);
  // 无场景图时环境回退文字锚定（有场景卡用定稿描述，什么都没有则只靠 scene_prompt）
  const locDesc = !locationImage && loc ? `环境设定：${loc.name}——${loc.description}。` : '';
  const outDesc = castOut.length > 0
    ? `另有角色 ${castOut.map((c) => `${c.name}——${c.appearance}${c.costume ? `，${c.costume}` : ''}`).join('；')}。`
    : '';

  const speakers = [...new Set(scene.dialogues.map((d) => d.speaker))];
  const mouth =
    scene.dialogues.length > 0
      ? `画面中只有正在说台词的角色（${speakers.join('、')}）嘴唇轻微开合，其他角色一律闭口`
      : '没有任何角色在说话，所有人物嘴唇全程保持闭合，只用表情与肢体动作传达剧情';
  const camera = `${scene.camera?.trim() || '镜头缓慢向主体轻微推近'}，首尾画面回到同一构图`;
  const rhythm = '动作流畅自然，速度适中，无突兀跳变';
  const aesthetic = `${script.style_anchor}，电影级光影层次，极高细节；角色与场景的外形、配色严格与参考图保持一致`;

  const action = `${bindings}${locDesc}${outDesc}${scene.scene_prompt}。${mouth}`;
  const prompt = [action, camera, rhythm, aesthetic].filter(Boolean).join('。');
  return { prompt, referenceImages: refs.map((r) => r.png) };
}

/** 中文约 4.5 字/秒、英文约 2.8 词/秒的朗读语速估算 */
function speechSeconds(text: string, lang: 'zh' | 'en'): number {
  if (!text) return 0;
  if (lang === 'en') {
    const words = text.split(/\s+/).filter(Boolean).length;
    return words / 2.8;
  }
  const chars = text.replace(/[\s，。！？、；：""'']+/g, '').length;
  return chars / 4.5;
}

/**
 * 单场片段时长（秒）：按本场台词+旁白字数估算（不预设时长，由内容决定）；
 * clamp 到 DashScope 视频生成支持的 [3, 10] 档位。
 */
export function estimateClipDurationSec(script: ScriptAnalysis, scene: ScriptScene): number {
  const spoken = [scene.narration ?? '', ...scene.dialogues.map((d) => d.line)]
    .map((t) => speechSeconds(t, script.lang))
    .reduce((a, b) => a + b, 0);
  return Math.min(10, Math.max(3, Math.round(spoken || 5)));
}
