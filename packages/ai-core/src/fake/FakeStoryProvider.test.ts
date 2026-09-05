import { describe, expect, it } from 'vitest';
import { FakeStoryProvider, climaxIndex, emotionForPage } from './FakeStoryProvider';
import { StorySchema } from '../story-schema';

const req = { theme: '孩子怕黑', style: 'watercolor' as const, lang: 'zh' as const, page_count: 6 };

describe('emotion arc', () => {
  it('starts calm and ends sleepy', () => {
    expect(emotionForPage(0, 6)).toBe('calm');
    expect(emotionForPage(5, 6)).toBe('sleepy');
  });

  it('climax sits three pages before the end', () => {
    expect(climaxIndex(10)).toBe(7);
    expect(climaxIndex(3)).toBe(0);
  });
});

describe('FakeStoryProvider', () => {
  it('produces schema-valid zh and en stories with shared structure', async () => {
    const p = new FakeStoryProvider();
    const zh = await p.generateStory(req);
    const en = await p.generateStory({ ...req, lang: 'en' });
    expect(() => StorySchema.parse(zh)).not.toThrow();
    expect(() => StorySchema.parse(en)).not.toThrow();
    expect(zh.pages.map((pg) => pg.page_id)).toEqual(en.pages.map((pg) => pg.page_id));
    expect(zh.pages.map((pg) => pg.is_climax)).toEqual(en.pages.map((pg) => pg.is_climax));
    expect(zh.pages.map((pg) => pg.emotion)).toEqual(en.pages.map((pg) => pg.emotion));
  });

  it('is deterministic', async () => {
    const p = new FakeStoryProvider();
    expect(await p.generateStory(req)).toEqual(await p.generateStory(req));
  });

  it('marks exactly one climax and provides valid fx hints', async () => {
    const story = await new FakeStoryProvider().generateStory(req);
    expect(story.pages.filter((pg) => pg.is_climax)).toHaveLength(1);
    for (const page of story.pages) {
      expect(page.fx_hints).toBeDefined();
      expect(page.fx_hints!.subjects.length).toBeGreaterThan(0);
    }
  });

  it('clamps page_count to [3, 14]', async () => {
    const p = new FakeStoryProvider();
    expect((await p.generateStory({ ...req, page_count: 1 })).pages).toHaveLength(3);
    expect((await p.generateStory({ ...req, page_count: 99 })).pages).toHaveLength(14);
  });

  it('uses a deterministic default when page_count is omitted (free-form pacing)', async () => {
    const p = new FakeStoryProvider();
    const { page_count: _ignored, ...noCount } = req;
    const story = await p.generateStory(noCount);
    expect(story.pages).toHaveLength(6);
    expect(() => StorySchema.parse(story)).not.toThrow();
  });

  it('ends with a core-message (moral) page addressed to the child', async () => {
    const story = await new FakeStoryProvider().generateStory(req);
    const last = story.pages[story.pages.length - 1]!;
    expect(last.narration).toContain('亲爱的小朋友');
    expect(last.narration).toContain('告诉我们');
    expect(last.scene_desc).toContain('温馨收尾画面');
    expect(['sleepy', 'calm']).toContain(last.emotion);
    // 倒数第二页仍是普通叙事页
    expect(story.pages[story.pages.length - 2]!.narration).not.toContain('亲爱的小朋友');
  });

  it('splits narration into speaker segments that rejoin to the original text', async () => {
    const story = await new FakeStoryProvider().generateStory(req);
    for (const page of story.pages) {
      expect(page.segments?.length).toBeGreaterThan(0);
      expect(page.segments!.map((s) => s.text).join('')).toBe(page.narration);
    }
    // 每 3 页出现一次角色对白段
    const hero = story.characters[0]!.name;
    expect(story.pages[2]!.segments!.some((s) => s.speaker === hero)).toBe(true);
    expect(story.characters[0]!.voice).toBeTruthy();
  });

  it('bumps version marker when reject_reason is given', async () => {
    const p = new FakeStoryProvider();
    const v1 = await p.generateStory(req);
    const v2 = await p.generateStory({ ...req, reject_reason: 'too scary' });
    expect(v1.title).toContain('v1');
    expect(v2.title).toContain('v2');
    expect(v2.pages[0]!.page_id).toBe(v1.pages[0]!.page_id);
  });
});
