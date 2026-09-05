import { describe, expect, it } from 'vitest';
import { createFakeProviders } from './providers';
import { StorySchema } from '../story-schema';

describe('createFakeProviders', () => {
  it('returns a fully wired bundle', async () => {
    const bundle = createFakeProviders();
    expect(bundle.story.name).toBe('fake-story');
    expect(bundle.image.name).toBe('fake-image');
    expect(bundle.matting.name).toBe('fake-matting');
    expect(bundle.tts?.name).toBe('fake-tts');
    expect(bundle.moderation.name).toBe('fake-moderation');
    const story = await bundle.story.generateStory({
      theme: '测试', style: 'watercolor', lang: 'zh', page_count: 3,
    });
    expect(() => StorySchema.parse(story)).not.toThrow();
  });

  it('accepts moderation overrides', async () => {
    const bundle = createFakeProviders({
      moderation: { rejectTextWhen: () => 'blocked' },
    });
    expect((await bundle.moderation.checkText('x')).verdict).toBe('reject');
  });
});
