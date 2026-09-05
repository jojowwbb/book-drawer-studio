import {
  AMBIENT_TYPES,
  BookSpecSchema,
  CAMERA_TYPES,
  SUBJECT_FX_TYPES,
  type AmbientSpec,
  type BookSpec,
  type CameraType,
  type SceneSpec,
  type SubjectFxType,
} from '@pb/renderer';
import {
  type Emotion,
  type Lang,
  type Story,
  type StoryCharacter,
  type StoryPage,
  type StyleId,
} from '@pb/ai-core';
import type { PageAssets } from './page-assets';

export const PAGE_DURATION_MS = 5000;

/** 片头幕时长：够读完标题与标签，又不拖沓 */
export const TITLE_DURATION_MS = 3600;

/** 片头幕在资产/清单里占用的伪页 id（不进入 story.pages，避免破坏末页核心思想与页数逻辑） */
export const TITLE_PAGE_ID = 'title';

/** 按渲染尺寸取构图方向词（插画 prompt 用） */
function orientationHint(size: { width: number; height: number }): string {
  return size.width < size.height ? '竖版 9:16' : '横版 16:9';
}

/**
 * 片头封面的文生图 prompt：与正文同一画风锚定，保证视觉统一；
 * 标题与标签由渲染层叠加，因此同样要求画面不出现文字（避免 AI 自带错别字）。
 */
export function buildCoverImagePrompt(
  story: Story,
  size: { width: number; height: number } = { width: 1920, height: 1080 },
): string {
  const cast = story.characters
    .slice(0, 3)
    .map((c) => `${c.name}——${c.appearance_desc}`)
    .join('；');
  const portrait = size.width < size.height;
  return [
    story.style_anchor,
    story.cover?.cover_prompt ?? `「${story.title}」的故事封面主视觉，主角与最具代表性的一幕`,
    cast ? `画面主角，严格保持外形一致：${cast}` : '',
    `爆款绘本封面构图，${orientationHint(size)}，${portrait ? '主体居中、纵向展开、上下留有呼吸感' : '主体居中偏上、视觉冲击力强、画面上半部留有呼吸感'}，画面中不要出现任何文字`,
  ].filter(Boolean).join('。');
}

/**
 * 每幕核心插画的文生图 prompt：画风锚定在前（模型对开头权重更高），
 * 场景描述居中，仅锚定该页出场角色（减少无关描述干扰、强化跨页一致性），
 * 末尾补构图与负向约束。
 */
export function buildImagePrompt(
  story: Story,
  page: StoryPage,
  size: { width: number; height: number } = { width: 1920, height: 1080 },
): string {
  const names = page.characters.length > 0 ? page.characters : story.characters.map((c) => c.name);
  const cast = names
    .map((n) => story.characters.find((c) => c.name === n))
    .filter((c): c is StoryCharacter => !!c);
  const castDesc = cast.length > 0
    ? `出场角色，严格保持外形一致：${cast.map((c) => `${c.name}——${c.appearance_desc}`).join('；')}`
    : '';
  return [
    story.style_anchor,
    page.scene_desc,
    castDesc,
    `${orientationHint(size)} 儿童绘本插画，单一完整场景定格构图，主体突出、背景留有呼吸感，画面中不要出现任何文字`,
  ].filter(Boolean).join('。');
}

/**
 * 审核驳回后的软化 prompt：去掉具体场景与角色描述（最易触发审核的部分），
 * 只保留画风锚 + 无人物无文字的通用安全场景 + 构图约束。
 */
export function buildFallbackImagePrompt(
  story: Story,
  size: { width: number; height: number } = { width: 1920, height: 1080 },
): string {
  return [
    story.style_anchor,
    '温馨治愈的自然小景：柔软的草地、远处的树影与柔和的天光，点缀几颗小星星，没有任何人物与动物',
    `${orientationHint(size)} 儿童绘本插画，单一完整场景构图，主体突出、背景留有呼吸感，画面中不要出现任何文字`,
  ].join('。');
}

export const EMOTION_FALLBACK: Record<
  Emotion,
  { camera: CameraType; ambient: AmbientSpec | null; subject_fx: SubjectFxType[] }
> = {
  calm: { camera: 'ken_burns_in', ambient: { type: 'stars_twinkle', density: 0.5 }, subject_fx: ['breathe'] },
  joyful: { camera: 'pan_right', ambient: { type: 'fireflies', density: 0.6 }, subject_fx: ['float', 'sway'] },
  tense: { camera: 'ken_burns_out', ambient: { type: 'clouds_drift', density: 0.5 }, subject_fx: ['sway'] },
  sad: { camera: 'static_breath', ambient: { type: 'rain', density: 0.4 }, subject_fx: ['breathe'] },
  wonder: { camera: 'pan_left', ambient: { type: 'light_rays', density: 0.5 }, subject_fx: ['float'] },
  sleepy: { camera: 'static_breath', ambient: { type: 'stars_twinkle', density: 0.4 }, subject_fx: ['breathe'] },
};

const STYLE_BASE_COLOR: Record<StyleId, string> = {
  watercolor: '#f7ede2',
  flat: '#101828',
  cartoon: '#fef3c7',
  crayon: '#fff7ed',
  anime: '#e0f2fe',
  chibi: '#fce7f3',
  ghibli: '#eef5e9',
  'colored-pencil': '#faf3e8',
  collage: '#fef9c3',
  gouache: '#f5e6d3',
  'realistic-3d': '#1c2128',
  'fantasy-picturebook': '#e8e0f5',
  inkwash: '#f4f1ea',
};

function pickCamera(page: StoryPage): CameraType {
  const hint = page.fx_hints?.camera;
  if (hint && (CAMERA_TYPES as readonly string[]).includes(hint)) return hint as CameraType;
  return EMOTION_FALLBACK[page.emotion].camera;
}

function pickAmbient(page: StoryPage): AmbientSpec | null {
  const hint = page.fx_hints?.ambient;
  if (hint && (AMBIENT_TYPES as readonly string[]).includes(hint)) {
    return { type: hint as AmbientSpec['type'], density: 0.5 };
  }
  return EMOTION_FALLBACK[page.emotion].ambient;
}

function pickSubjectFx(page: StoryPage): SubjectFxType[] {
  const hints = (page.fx_hints?.subjects ?? []).filter((s): s is SubjectFxType =>
    (SUBJECT_FX_TYPES as readonly string[]).includes(s),
  );
  return hints.length > 0 ? hints : EMOTION_FALLBACK[page.emotion].subject_fx;
}

export interface BuildSceneSpecArgs {
  page: StoryPage;
  lang: Lang;
  style: StyleId;
  size: { width: number; height: number };
  assets: PageAssets;
}

export function buildSceneSpec(args: BuildSceneSpecArgs): SceneSpec {
  const { page, style, size, assets } = args;
  const durationMs = PAGE_DURATION_MS;
  const fx = pickSubjectFx(page);
  const subjects = assets.subject_urls.map((src, i) => ({
    src,
    x: Math.round(size.width * ((i + 1) / (assets.subject_urls.length + 1))),
    y: Math.round(size.height * 0.7),
    scale: 1,
    fx,
  }));
  const ambient = pickAmbient(page);
  const spec: SceneSpec = {
    page_id: page.page_id,
    duration_ms: durationMs,
    width: size.width,
    height: size.height,
    seed: assets.seed,
    base_color: STYLE_BASE_COLOR[style],
    background: { src: assets.background_url },
    subjects,
    camera: { type: pickCamera(page), intensity: page.is_climax ? 0.7 : 0.5 },
    ambient: ambient ? [ambient] : [],
    // 情节音效：透传文案生成阶段分析的 cues（渲染层忽略，导出混音按 at 时刻拟音）
    sfx: (page.sfx ?? []).map((c) => ({ type: c.type, at: c.at ?? 0.5 })),
    // 字幕与旁白 TTS 同源（合成语音用的就是 narration），画面文字与语音内容保持一致
    subtitle: { text: page.narration || page.page_text },
  };
  if (assets.foreground_url) spec.foreground = { src: assets.foreground_url };
  return spec;
}

export interface BuildBookSpecArgs {
  bookId: string;
  story: Story;
  lang: Lang;
  style: StyleId;
  size: { width: number; height: number };
  pageAssets: Map<string, PageAssets>;
}

/** 片头幕场景：封面插画打底，AI 标题/副标题/标签由渲染层叠加（无普通字幕） */
const TITLE_BASE_COLOR = '#101828';

/** 片头旁白文本：只念大标题（副标题与标签只作视觉呈现，念出来像报菜名） */
export function coverNarrationText(story: Story): string {
  return story.cover!.title;
}

export function buildTitleSceneSpec(args: {
  story: Story;
  size: { width: number; height: number };
  assets: PageAssets;
}): SceneSpec {
  const { story, size, assets } = args;
  const cover = story.cover!;
  const spec: SceneSpec = {
    page_id: TITLE_PAGE_ID,
    duration_ms: TITLE_DURATION_MS,
    width: size.width,
    height: size.height,
    seed: assets.seed,
    base_color: TITLE_BASE_COLOR,
    background: { src: assets.background_url },
    subjects: [],
    camera: { type: 'ken_burns_in', intensity: 0.35 },
    ambient: [{ type: 'light_rays', density: 0.35 }],
    sfx: [],
    title_overlay: {
      title: cover.title,
      subtitle: cover.subtitle,
      tags: cover.tags,
    },
  };
  return spec;
}

export function buildBookSpec(args: BuildBookSpecArgs): BookSpec {
  const pages = args.story.pages.map((page) => {
    const pageAssets = args.pageAssets.get(page.page_id);
    if (!pageAssets) throw new Error(`missing assets for page ${page.page_id}`);
    return buildSceneSpec({
      page,
      lang: args.lang,
      style: args.style,
      size: args.size,
      assets: pageAssets,
    });
  });
  // 片头幕：有封面文案且封面图已生成时前置为第一幕（旧书无 cover 则跳过）
  const titleAssets = args.pageAssets.get(TITLE_PAGE_ID);
  if (args.story.cover && titleAssets) {
    pages.unshift(
      buildTitleSceneSpec({
        story: args.story,
        size: args.size,
        assets: titleAssets,
      }),
    );
  }
  return BookSpecSchema.parse({ id: `${args.bookId}-${args.lang}`, pages });
}
