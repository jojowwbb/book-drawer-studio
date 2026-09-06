/**
 * 分角色配音音色板（阿里百炼 Qwen-TTS 系统音色，中英双语均支持）。
 * 编剧 AI 为每个角色从这里挑一个音色写入 story.characters[].voice，
 * 配音时按「说话人 → 角色音色」映射逐段合成；旁白段不指定 voice，
 * 走供应商全局默认音色（TTS_VOICE）。
 *
 * 清单对齐官方《Qwen-TTS 非实时语音合成音色列表》（2026-09-02 版）：
 * 仅收录当前产线模型 qwen3-tts-instruct-flash 可用的系统音色（Cherry/Serena/Ethan/
 * Chelsie/Momo/Vivian/Moon/Maia/Kai/Nofish/Bella/Eldric Sage/Mia/Mochi/Bellona/
 * Vincent/Bunny/Neil/Elias/Arthur/Nini/Seren/Pip/Stella），并剔除品牌音色
 * （Jennifer/Ryan/Katerina/Aiden 等仅 flash 原版可用）与方言/外语角色音色
 * （Jada 沪语/Dylan 北京话/Li 南京话/Bodega 西语等），绘本配音用不上。
 * 描述取自官方原文（部分补注绘本适用角色）。
 */

export const NARRATOR = '旁白';

/** 音色 id → 适用角色描述（这份说明会进 prompt，指导 AI 挑选） */
export const VOICE_PALETTE: Record<string, string> = {
  // —— 儿童音色（绘本对白优先从这里选）——
  Bella: '萌宝——软糯幼龄女童声（幼儿园年纪的小女孩角色）',
  Bunny: '萌小姬——萌属性爆棚的小女孩声（小女孩角色）',
  Nini: '邻家妹妹——又软又甜的黏糯女童声（小妹妹类角色）',
  Mia: '乖小妹——温顺乖巧的女童声（文静小女孩角色）',
  Stella: '少女阿月——甜美又有正义感的少女声（姐姐、小英雄类角色）',
  Mochi: '沙小弥——聪明伶俐、奶声奶气的小男孩声（小男孩角色）',
  Pip: '顽屁小孩——调皮捣蛋、充满童真的男童声（淘气小男孩角色）',
  // —— 成人音色（父母、长辈、旁白类角色）——
  Cherry: '芊悦——阳光亲切自然的女声（姐姐、年轻女性角色）',
  Serena: '苏瑶——温柔年轻女声（妈妈类角色）',
  Maia: '四月——知性温柔女声（老师、知性女性角色）',
  Seren: '小婉——温和舒缓的轻声细语（睡前安抚类角色）',
  Chelsie: '千雪——二次元少女声（动漫感女孩角色）',
  Momo: '茉兔——撒娇搞怪、逗人开心的女声（活宝类角色）',
  Vivian: '十三——拽拽的、可爱的小暴躁女声（傲娇角色）',
  Bellona: '燕铮莺——洪亮字正腔圆、戏感强的女声（反派、女王、说书类角色）',
  Ethan: '晨煦——阳光温暖、有活力的男声（爸爸、青年男性角色）',
  Moon: '月白——率性帅气的男声（酷酷的男性角色）',
  Kai: '凯——舒缓温柔、如耳畔低语的男声（温柔的哥哥类角色）',
  Vincent: '田叔——沙哑烟嗓、江湖豪情的男声（粗犷大叔类角色）',
  Nofish: '不吃鱼——慵懒随性的男声（散漫搞笑类角色）',
  Neil: '阿闻——字正腔圆的新闻主持人男声（报幕、一本正经的搞笑角色）',
  Elias: '墨讲师——严谨又善于叙事的讲解女声（知识讲解类旁白）',
  Arthur: '徐大爷——不疾不徐、质朴的长者讲故事声（爷爷、老智者类角色）',
  'Eldric Sage': '沧明子——沉稳睿智、沧桑温和的老者声（老爷爷、仙人角色）',
};

const KNOWN_VOICES = new Set(Object.keys(VOICE_PALETTE));

/** 校验 AI 产出的音色 id；未知/非法返回 undefined（回退默认音色） */
export function normalizeVoice(voice: string | undefined): string | undefined {
  if (!voice) return undefined;
  const trimmed = voice.trim();
  return KNOWN_VOICES.has(trimmed) ? trimmed : undefined;
}

/** 给 prompt 用的音色板清单 */
export function voicePaletteLines(): string {
  return Object.entries(VOICE_PALETTE)
    .map(([id, desc]) => `${id}——${desc}`)
    .join('；');
}

/** 朗读时不应出现的引号（中英文直角/弯引号）；用于把带引号的 narration 与无引号的 segments 对齐 */
const QUOTE_CHARS = new RegExp('[\\u201C\\u201D\\u2018\\u2019\\u0022\\u0027\\u300C\\u300D\\u300E\\u300F]', 'g');

export function stripNarrationQuotes(text: string): string {
  return text.replace(QUOTE_CHARS, '');
}

/** 分段的最小结构（与 story-schema 的 NarrationSegment 兼容，此处不引入依赖避免循环引用） */
export interface RawSegment {
  speaker: string;
  text: string;
}

/**
 * 修复 AI 分段时丢失的旁白过渡句。
 *
 * 现象：narration 里两句对白之间的引导语（如「阿牛却摆摆手说：」）有时被 AI 从 segments
 * 里整个删掉，导致配音漏读这段旁白（字幕取自 narration 仍完整，听感上「旁白没了」）。
 *
 * 做法：把 segments 逐段在「去引号后的 narration」中按序定位，相邻段之间未被任何段覆盖的
 * 文字补回为独立「旁白」段，保证所有段 text 拼接后与去引号 narration 完全一致。
 * 无法按序定位的段（AI 改写了文本）原样保留，不做破坏性处理；无分段时回退整段旁白。
 */
export function repairSegments(narration: string, segments: RawSegment[] | undefined): RawSegment[] {
  if (!segments?.length) return [{ speaker: NARRATOR, text: narration }];
  const flat = stripNarrationQuotes(narration);
  const repaired: RawSegment[] = [];
  let cursor = 0;
  for (const seg of segments) {
    const text = stripNarrationQuotes(seg.text);
    if (!text) {
      repaired.push(seg);
      continue;
    }
    const idx = flat.indexOf(text, cursor);
    if (idx < 0) {
      repaired.push(seg); // 定位失败：保守保留原段，不猜测插入位置
      continue;
    }
    if (idx > cursor) repaired.push({ speaker: NARRATOR, text: flat.slice(cursor, idx) });
    repaired.push(seg);
    cursor = idx + text.length;
  }
  if (cursor < flat.length) repaired.push({ speaker: NARRATOR, text: flat.slice(cursor) });
  return repaired;
}

/**
 * 用户手写的分角色台词标记 → segments。
 *
 * 背景：AI 归一化无法识别的 speaker 会被并入旁白（宁可旁白也不错配），
 * 用户可在「编辑旁白」里用标记手动指定说话人修复后重新生成配音：
 *   【旁白】天黑了。【小兔】妈妈，我害怕……【旁白】兔妈妈把小兔搂进怀里。
 *
 * 规则：标记必须是【名字】格式；名字等于「旁白」（或 NARRATOR 常量）→ 旁白段，
 * 否则原样保留为角色名（由调用方校验是否在角色表内）；第一个标记之前的文本
 * 视为旁白（兼容用户只在角色台词前加标记的写法）；无标记时整段回退为旁白，
 * 行为与 repairSegments(…, undefined) 一致。
 */
export function parseSpeakerMarkup(text: string): RawSegment[] {
  const MARK = /[【\[]([^\]】]+)[】\]]/g;
  const segments: RawSegment[] = [];
  let cursor = 0;
  let current: { speaker: string; text: string } | null = null;
  const pushCurrent = () => {
    if (!current) return;
    const body = current.text.trim();
    if (body) segments.push({ speaker: current.speaker, text: body });
    current = null;
  };
  for (const m of text.matchAll(MARK)) {
    const idx = m.index ?? 0;
    if (current) {
      current.text += text.slice(cursor, idx);
      pushCurrent();
    } else {
      // 第一个标记之前的文本：旁白
      const lead = text.slice(cursor, idx).trim();
      if (lead) segments.push({ speaker: NARRATOR, text: lead });
    }
    const name = m[1]!.trim();
    current = { speaker: !name || name === NARRATOR ? NARRATOR : name, text: '' };
    cursor = idx + m[0].length;
  }
  if (current) {
    current.text += text.slice(cursor);
    pushCurrent();
  } else if (segments.length === 0 && text.trim()) {
    // 没有任何标记：整段旁白（普通文本编辑路径，行为不变）
    return [{ speaker: NARRATOR, text: text.trim() }];
  }
  return segments;
}

/** segments → 纯文本旁白（字幕/TTS 兜底用）：直接拼接各段文本，与逐段朗读内容一致，
 * 保证 repairSegments 能在 narration 中按序定位每个分段（引导语由旁白段自带） */
export function segmentsToNarration(segments: RawSegment[]): string {
  return segments.map((s) => s.text).join('');
}
