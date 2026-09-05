import { describe, expect, it } from 'vitest';
import { loadRealProvidersConfig } from './config';
import { createRealProjectProviders, createRealProviders } from './providers';
import { OpenAICompatibleImageProvider } from './OpenAICompatibleImageProvider';
import { OpenAICompatibleVideoProvider } from './OpenAICompatibleVideoProvider';

const cfg = loadRealProvidersConfig({
  TEXT_API_KEY: 'k1',
  IMAGE_API_KEY: 'k2',
  VIDEO_API_KEY: 'k3',
  TTS_API_KEY: 'k4',
});

describe('createRealProviders', () => {
  it('wires story/image/tts/matting/moderation without videoClip', () => {
    const bundle = createRealProviders(cfg);
    expect(bundle.story.name).toBe('story:deepseek-chat');
    expect(bundle.image.name).toBe('image:qwen-image-2.0');
    expect(bundle).not.toHaveProperty('videoClip');
    expect(bundle.tts?.name).toBe('tts:qwen3-tts-instruct-flash');
    expect(bundle.matting.name).toBe('matting:identity');
    expect(bundle.moderation.name).toBe('fake-moderation');
  });

  it('wires protocol-specific providers from per-capability *_API', () => {
    const bundle = createRealProjectProviders(
      loadRealProvidersConfig({
        TEXT_API_KEY: 'k1',
        TEXT_MODEL: 'glm-4.7',
        IMAGE_API: 'openai',
        IMAGE_BASE_URL: 'https://api.openai.com/v1',
        IMAGE_API_KEY: 'sk-oai',
        IMAGE_MODEL: 'gpt-image-1',
        VIDEO_API: 'newapi',
        VIDEO_BASE_URL: 'https://gateway.example.com/v1',
        VIDEO_API_KEY: 'sk-gw',
        VIDEO_MODEL: 'kling-v2-1',
        TTS_API_KEY: 'k4',
      }),
    );
    expect(bundle.script.name).toBe('script:glm-4.7');
    expect(bundle.image.name).toBe('image:gpt-image-1');
    expect(bundle.image).toBeInstanceOf(OpenAICompatibleImageProvider);
    expect(bundle.videoClip).toBeInstanceOf(OpenAICompatibleVideoProvider);
    expect(bundle.videoClip?.name).toBe('video:kling-v2-1');
  });
});

describe('createRealProjectProviders', () => {
  it('wires script/image/videoClip/tts/moderation without story/matting', () => {
    const bundle = createRealProjectProviders(cfg);
    expect(bundle.script.name).toBe('script:deepseek-chat');
    expect(bundle.image.name).toBe('image:qwen-image-2.0');
    expect(bundle.videoClip?.name).toBe('video:wan2.7-r2v-2026-06-12');
    expect(bundle.tts?.name).toBe('tts:qwen3-tts-instruct-flash');
    expect(bundle.moderation.name).toBe('fake-moderation');
  });
});
