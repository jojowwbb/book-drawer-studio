import { describe, expect, it } from 'vitest';
import { EMOTIONS, SfxCueListSchema, StorySchema } from './story-schema';

function minimalStory() {
  return {
    title: '怕黑的小熊 v1',
    style_anchor: 'warm watercolor',
    lang: 'zh',
    characters: [{ name: '小暖', appearance_desc: '圆滚滚的小熊' }],
    pages: Array.from({ length: 3 }, (_, i) => ({
      page_id: `p${i + 1}`,
      page_text: `第 ${i + 1} 页`,
      narration: `第 ${i + 1} 页旁白`,
      scene_desc: `场景 ${i + 1}`,
      emotion: 'calm',
    })),
  };
}

describe('StorySchema', () => {
  it('parses minimal story with defaults', () => {
    const story = StorySchema.parse(minimalStory());
    expect(story.age_hint).toBe('3-6');
    expect(story.pages[0]!.characters).toEqual([]);
    expect(story.pages[0]!.is_climax).toBe(false);
    expect(story.pages[0]!.fx_hints).toBeUndefined();
  });

  it('exposes exactly six emotions', () => {
    expect(EMOTIONS).toEqual(['calm', 'joyful', 'tense', 'sad', 'wonder', 'sleepy']);
  });

  it('rejects unknown emotion', () => {
    const bad = { ...minimalStory() };
    bad.pages = [{ ...bad.pages[0]!, emotion: 'angry' }];
    expect(() => StorySchema.parse(bad)).toThrow();
  });

  it('enforces 3-30 pages', () => {
    const two = { ...minimalStory(), pages: minimalStory().pages.slice(0, 2) };
    expect(() => StorySchema.parse(two)).toThrow();
    const thirtyOne = {
      ...minimalStory(),
      pages: Array.from({ length: 31 }, (_, i) => ({ ...minimalStory().pages[0]!, page_id: `p${i}` })),
    };
    expect(() => StorySchema.parse(thirtyOne)).toThrow();
  });

  it('accepts fx_hints and climax flags', () => {
    const story = StorySchema.parse({
      ...minimalStory(),
      pages: [
        {
          ...minimalStory().pages[0]!,
          is_climax: true,
          fx_hints: { camera: 'ken_burns_in', subjects: ['breathe'], ambient: 'stars_twinkle' },
        },
        ...minimalStory().pages.slice(1),
      ],
    });
    expect(story.pages[0]!.is_climax).toBe(true);
    expect(story.pages[0]!.fx_hints?.camera).toBe('ken_burns_in');
  });

  it('accepts en lang', () => {
    expect(StorySchema.parse({ ...minimalStory(), lang: 'en' }).lang).toBe('en');
  });

  it('drops hallucinated sfx types and unknown fields', () => {
    const parsed = SfxCueListSchema.parse([
      { type: 'thunder', at: 0.2 },
      { type: 'growl' }, // 幻觉类型：整条丢弃
      { type: 'laugh', mode: 'bg' }, // 多余字段：parse 时剥离
    ]);
    expect(parsed).toEqual([
      { type: 'thunder', at: 0.2 },
      { type: 'laugh' },
    ]);
  });
});
