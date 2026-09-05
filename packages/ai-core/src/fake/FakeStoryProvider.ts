import type { Story, StoryPage, Emotion, NarrationSegment, SfxCue } from '../story-schema';
import type { StoryProvider, StoryRequest, Lang, StyleId } from '../types';
import { NARRATOR } from '../voices';

const STYLE_ANCHORS: Record<StyleId, string> = {
  watercolor: '暖色水彩手绘，柔和笔触，纸张纹理，儿童绘本风',
  flat: '现代扁平插画，干净几何造型，明快配色',
  cartoon: '明亮卡通插画，粗黑描边，高饱和色彩，夸张可爱的表情动作',
  crayon: '蜡笔涂鸦卡通，稚拙粗线条，鲜艳色块，充满童趣的手绘质感',
  anime: '日系动画插画，干净线条，柔和赛璐璐上色，梦幻通透的光影',
  chibi: 'Q版chibi卡通，大头小身超变形造型，圆润可爱，大眼睛高光',
  ghibli: '吉卜力风格手绘动画插画，柔和自然光，细腻丰富的背景，温暖怀旧氛围',
  'colored-pencil': '彩色铅笔手绘插画，细腻颗粒质感，柔和粉彩渐变，欧洲经典绘本风',
  collage: '纸质拼贴剪纸插画，层叠色块，明显纸张纹理与毛边，鲜艳撞色',
  gouache: '水粉厚涂插画，哑光不透明笔触，复古儿童绘本配色，柔和边缘',
  'realistic-3d': '写实 3D 动画渲染风格，电影级布光，逼真的皮肤、毛发与材质细节，丰富的环境光遮蔽与景深',
  'fantasy-picturebook': '奇幻绘本插画，梦幻瑰丽的光影，繁复精致的魔法细节，油画质感与童话氛围',
  inkwash: '中国水墨画风格，宣纸质感，墨色浓淡晕染，留白意境，山水氤氲，淡彩点缀',
};

export function emotionForPage(index: number, total: number): Emotion {
  const p = index / Math.max(1, total - 1);
  if (p === 0) return 'calm';
  if (p < 0.4) return 'wonder';
  if (p < 0.7) return 'joyful';
  if (p < 0.85) return 'tense';
  return 'sleepy';
}

export function climaxIndex(total: number): number {
  return Math.max(0, total - 3);
}

const FX_HINTS_BY_EMOTION: Record<Emotion, { camera: string; subjects: string[]; ambient: string }> = {
  calm: { camera: 'ken_burns_in', subjects: ['breathe'], ambient: 'stars_twinkle' },
  joyful: { camera: 'pan_right', subjects: ['float', 'sway'], ambient: 'fireflies' },
  tense: { camera: 'ken_burns_out', subjects: ['sway'], ambient: 'clouds_drift' },
  sad: { camera: 'static_breath', subjects: ['breathe'], ambient: 'rain' },
  wonder: { camera: 'pan_left', subjects: ['float'], ambient: 'light_rays' },
  sleepy: { camera: 'static_breath', subjects: ['breathe'], ambient: 'stars_twinkle' },
};

function pageText(theme: string, hero: string, index: number, lang: Lang): string {
  if (lang === 'zh') {
    return `第 ${index + 1} 页：关于「${theme}」，${hero}轻轻地往前走，夜色变得温柔起来。`;
  }
  return `Page ${index + 1}: About "${theme}", ${hero} walked on softly, and the night grew gentle.`;
}

/** 每 3 页安排一次角色对白（确定性），用于覆盖分角色配音链路；narration 即各段拼接 */
function pageSegments(text: string, hero: string, index: number, lang: Lang): NarrationSegment[] {
  if ((index + 1) % 3 === 0) {
    return lang === 'zh'
      ? [
          { speaker: NARRATOR, text: `${text}${hero}轻轻地说：` },
          { speaker: hero, text: '晚安，明天见。' },
        ]
      : [
          { speaker: NARRATOR, text: `${text} ${hero} whispered:` },
          { speaker: hero, text: ' Good night, see you tomorrow.' },
        ];
  }
  return [{ speaker: NARRATOR, text }];
}

/** 确定性情节音效：欢快页有笑声、每 3 页有脚步声（供音效混音链路测试） */
function sfxForPage(emotion: Emotion, index: number, isMoral: boolean): SfxCue[] {
  if (isMoral) return [];
  const cues: SfxCue[] = [];
  if (emotion === 'joyful') cues.push({ type: 'laugh', at: 0.5 });
  if ((index + 1) % 3 === 0) cues.push({ type: 'footsteps', at: 0.25 });
  return cues;
}

/** 最后一页固定为「核心思想」幕：用对小朋友说话的口吻点出故事道理（确定性文案） */
function moralText(theme: string, hero: string, lang: Lang): string {
  if (lang === 'zh') {
    return `亲爱的小朋友，关于「${theme}」的故事讲完啦。${hero}告诉我们呀：只要心里有光，就不怕黑夜，晚安。`;
  }
  return `Dear little friend, the story of "${theme}" is over. ${hero} teaches us: with light in your heart, the dark is not scary. Good night.`;
}

export class FakeStoryProvider implements StoryProvider {
  readonly name = 'fake-story';

  async generateStory(req: StoryRequest): Promise<Story> {
    const version = req.reject_reason ? 2 : 1;
    // 未指定页数时（AI 自行分幕）用固定值，保证 Fake 桩确定性
    const total = req.page_count === undefined ? 6 : Math.min(14, Math.max(3, req.page_count));
    const hero = req.lang === 'zh' ? '小暖' : 'Nova';
    const heroDesc =
      req.lang === 'zh'
        ? `圆滚滚的小熊，暖棕色绒毛，围着红色围巾（主题：${req.theme}）`
        : `A chubby little bear with warm brown fur and a red scarf (theme: ${req.theme})`;

    const pages: StoryPage[] = Array.from({ length: total }, (_, i) => {
      const emotion = emotionForPage(i, total);
      const isMoral = i === total - 1;
      const text = isMoral ? moralText(req.theme, hero, req.lang) : pageText(req.theme, hero, i, req.lang);
      const hint = FX_HINTS_BY_EMOTION[emotion];
      // 核心思想幕保持纯旁白；其余页每 3 页出现一次角色对白段。narration 由分段拼接而来，保证一致
      const segments = isMoral ? [{ speaker: NARRATOR, text }] : pageSegments(text, hero, i, req.lang);
      const narration = segments.map((s) => s.text).join('');
      return {
        page_id: `p${i + 1}`,
        page_text: narration,
        narration,
        segments,
        scene_desc: isMoral
          ? `温馨收尾画面：${hero}在星光下安然入睡，画面中央柔和光晕，${STYLE_ANCHORS[req.style]}`
          : `${STYLE_ANCHORS[req.style]}，${req.theme}，第 ${i + 1} 页场景`,
        characters: [hero],
        emotion,
        is_climax: i === climaxIndex(total),
        fx_hints: { camera: hint.camera, subjects: [...hint.subjects], ambient: hint.ambient },
        // 确定性情节音效：欢快页有笑声、每 3 页有脚步声，供音效混音链路测试
        sfx: sfxForPage(emotion, i, isMoral),
      };
    });

    return {
      title: req.title ?? `${req.theme} v${version}`,
      age_hint: '3-6',
      style_anchor: STYLE_ANCHORS[req.style],
      lang: req.lang,
      cover:
        req.lang === 'zh'
          ? {
              title: req.title ?? `${req.theme}`,
              subtitle: `${hero}的奇妙夜`,
              tags: ['睡前故事', '温柔治愈', req.theme],
              cover_prompt: `${hero}站在开满星光的山坡上回望，温暖治愈的故事封面主视觉`,
            }
          : {
              title: req.title ?? `${req.theme}`,
              subtitle: `${hero}'s wondrous night`,
              tags: ['bedtime', 'gentle', req.theme],
              cover_prompt: `${hero} standing on a starlit hill looking back, warm healing cover key visual`,
            },
      characters: [{ name: hero, appearance_desc: heroDesc, voice: req.lang === 'zh' ? 'Mochi' : 'Pip' }],
      pages,
    };
  }
}
