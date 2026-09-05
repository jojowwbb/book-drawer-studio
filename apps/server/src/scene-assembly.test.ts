import { describe, expect, it } from 'vitest';
import { AMBIENT_TYPES, BookSpecSchema, CAMERA_TYPES, SceneSpecSchema } from '@pb/renderer';
import type { StoryPage } from '@pb/ai-core';
import { buildBookSpec, buildImagePrompt, buildSceneSpec, PAGE_DURATION_MS } from './scene-assembly';
import type { PageAssets } from './page-assets';

const size = { width: 640, height: 360 };

function page(overrides: Partial<StoryPage> = {}): StoryPage {
  return {
    page_id: 'p1',
    page_text: '月亮升起来了',
    narration: '月亮升起来了',
    scene_desc: '夜空下的森林',
    characters: ['小暖'],
    emotion: 'calm',
    is_climax: false,
    ...overrides,
  };
}

function assets(overrides: Partial<PageAssets> = {}): PageAssets {
  return {
    page_id: 'p1',
    seed: 42,
    image_url: '/assets/books/b/pages/p1/full.png',
    background_url: '/assets/books/b/pages/p1/background.png',
    subject_urls: ['/assets/books/b/pages/p1/subjects/s0.png'],
    ...overrides,
  };
}

describe('buildSceneSpec', () => {
  it('sets duration to the fixed clip duration and passes renderer schema', () => {
    const spec = buildSceneSpec({ page: page(), lang: 'zh', style: 'watercolor', size, assets: assets() });
    expect(spec.duration_ms).toBe(PAGE_DURATION_MS);
    expect(() => SceneSpecSchema.parse(spec)).not.toThrow();
  });

  it('falls back to emotion preset when fx_hints are missing', () => {
    const spec = buildSceneSpec({ page: page(), lang: 'zh', style: 'watercolor', size, assets: assets() });
    expect(spec.camera.type).toBe('ken_burns_in'); // calm
    expect(spec.ambient).toEqual([{ type: 'stars_twinkle', density: 0.5 }]);
    expect(spec.subjects[0]!.fx).toEqual(['breathe']);
  });

  it('passes plot sfx cues through with defaulted at', () => {
    const spec = buildSceneSpec({
      page: page({ sfx: [{ type: 'laugh', at: 0.3 }, { type: 'door' }] }),
      lang: 'zh', style: 'watercolor', size, assets: assets(),
    });
    expect(spec.sfx).toEqual([
      { type: 'laugh', at: 0.3 },
      { type: 'door', at: 0.5 },
    ]);
    expect(() => SceneSpecSchema.parse(spec)).not.toThrow();
  });

  it('honors valid hints and ignores out-of-enum hints', () => {
    const spec = buildSceneSpec({
      page: page({
        fx_hints: { camera: 'pan_left', subjects: ['float', 'zoom_wild'], ambient: 'not_a_type' },
      }),
      lang: 'zh', style: 'watercolor', size, assets: assets(),
    });
    expect(spec.camera.type).toBe('pan_left');
    expect(spec.subjects[0]!.fx).toEqual(['float']);
    expect(spec.ambient[0]!.type).toBe('stars_twinkle'); // fell back
  });

  it('drops all-invalid subject hints to emotion fallback', () => {
    const spec = buildSceneSpec({
      page: page({ fx_hints: { subjects: ['nope'] } }),
      lang: 'zh', style: 'watercolor', size, assets: assets(),
    });
    expect(spec.subjects[0]!.fx).toEqual(['breathe']);
  });

  it('uses climax intensity and spreads subjects evenly', () => {
    const a = assets({
      subject_urls: ['/s0.png', '/s1.png'],
    });
    const spec = buildSceneSpec({ page: page({ is_climax: true }), lang: 'zh', style: 'watercolor', size, assets: a });
    expect(spec.camera.intensity).toBe(0.7);
    expect(spec.subjects.map((s) => s.x)).toEqual([213, 427]);
    expect(spec.subjects.map((s) => s.y)).toEqual([252, 252]);
  });

  it('uses narration (TTS source) for subtitle, not page_text', () => {
    const spec = buildSceneSpec({
      page: page({ page_text: '短句', narration: '月亮升起来了，森林里静悄悄的。' }),
      lang: 'zh', style: 'watercolor', size,
      assets: assets({ foreground_url: '/fg.png' }),
    });
    expect(spec.subtitle).toEqual({ text: '月亮升起来了，森林里静悄悄的。' });
    expect(spec.audio_refs).toBeUndefined();
    expect(spec.foreground).toEqual({ src: '/fg.png' });
  });

  it('falls back to page_text when narration is empty', () => {
    const spec = buildSceneSpec({
      page: page({ page_text: '月亮升起来了', narration: '' }),
      lang: 'zh', style: 'watercolor', size, assets: assets(),
    });
    expect(spec.subtitle).toEqual({ text: '月亮升起来了' });
  });
});

describe('buildBookSpec', () => {
  it('assembles all pages and validates against renderer BookSpecSchema', () => {
    const story = {
      title: 't v1', age_hint: '3-6', style_anchor: 'a', lang: 'zh' as const,
      characters: [{ name: '小暖', appearance_desc: 'bear' }],
      pages: [page(), page({ page_id: 'p2' }), page({ page_id: 'p3' })],
    };
    const pageAssets = new Map<string, PageAssets>([
      ['p1', assets()],
      ['p2', assets({ page_id: 'p2' })],
      ['p3', assets({ page_id: 'p3' })],
    ]);
    const book = buildBookSpec({ bookId: 'b', story, lang: 'zh', style: 'watercolor', size, pageAssets });
    expect(book.id).toBe('b-zh');
    expect(book.pages).toHaveLength(3);
    expect(() => BookSpecSchema.parse(book)).not.toThrow();
  });

  it('base_color follows the style palette', () => {
    const story = {
      title: '小海龟找家', age_hint: '3-6', style_anchor: 'a', lang: 'zh' as const,
      characters: [{ name: '龟龟', appearance_desc: 'turtle' }],
      pages: [page(), page({ page_id: 'p2' }), page({ page_id: 'p3' })],
    };
    const pageAssets = new Map<string, PageAssets>([
      ['p1', assets()],
      ['p2', assets({ page_id: 'p2' })],
      ['p3', assets({ page_id: 'p3' })],
    ]);
    const book = buildBookSpec({ bookId: 'b', story, lang: 'zh', style: 'watercolor', size, pageAssets });
    expect(book.pages[0]!.base_color).toBe('#f7ede2');
    const flat = buildBookSpec({ bookId: 'b', story, lang: 'zh', style: 'flat', size, pageAssets });
    expect(flat.pages[0]!.base_color).toBe('#101828');
  });

  it('throws when a page has no assets', () => {
    const story = {
      title: 't v1', age_hint: '3-6', style_anchor: 'a', lang: 'zh' as const,
      characters: [{ name: '小暖', appearance_desc: 'bear' }],
      pages: [page(), page({ page_id: 'p2' }), page({ page_id: 'p3' })],
    };
    expect(() =>
      buildBookSpec({ bookId: 'b', story, lang: 'zh', style: 'watercolor', size, pageAssets: new Map() }),
    ).toThrow(/missing assets/);
  });

  it('only uses enum values from @pb/renderer', () => {
    const spec = buildSceneSpec({ page: page({ emotion: 'joyful' }), lang: 'zh', style: 'watercolor', size, assets: assets() });
    expect(CAMERA_TYPES).toContain(spec.camera.type);
    expect(spec.ambient.every((a) => AMBIENT_TYPES.includes(a.type))).toBe(true);
  });
});

describe('buildImagePrompt', () => {
  const story = {
    title: 't', age_hint: '3-6', style_anchor: '暖色水彩手绘', lang: 'zh' as const,
    characters: [
      { name: '小暖', appearance_desc: '圆滚滚的小熊，暖棕色绒毛，红色围巾' },
      { name: '灯灯', appearance_desc: '发着暖黄光的萤火虫' },
    ],
    pages: [page()],
  };

  it('anchors style first, describes only the cast on this page, appends composition guard', () => {
    const p = buildImagePrompt(story, page({ characters: ['小暖'] }));
    expect(p.startsWith('暖色水彩手绘。')).toBe(true);
    expect(p).toContain('夜空下的森林');
    expect(p).toContain('小暖——圆滚滚的小熊，暖棕色绒毛，红色围巾');
    expect(p).not.toContain('灯灯');
    expect(p).toContain('画面中不要出现任何文字');
  });

  it('falls back to all characters when the page lists none', () => {
    const p = buildImagePrompt(story, page({ characters: [] }));
    expect(p).toContain('小暖——');
    expect(p).toContain('灯灯——');
  });
});
