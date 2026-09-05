import { describe, expect, it } from 'vitest';
import { MissingEnvError, loadRealProvidersConfig } from './config';

// 四组能力各自独立配置：TEXT / IMAGE / VIDEO / TTS，每组 <前缀>_API / _BASE_URL / _API_KEY / _MODEL
const baseEnv = {
  TEXT_API_KEY: 'sk-text',
  IMAGE_API_KEY: 'sk-image',
  VIDEO_API_KEY: 'sk-video',
  TTS_API_KEY: 'sk-tts',
};

describe('loadRealProvidersConfig', () => {
  it('parses four independent providers with defaults', () => {
    const cfg = loadRealProvidersConfig(baseEnv);
    expect(cfg.text).toEqual({
      api: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-text', model: 'deepseek-chat',
    });
    expect(cfg.image).toEqual({
      api: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', apiKey: 'sk-image', model: 'qwen-image-2.0',
    });
    expect(cfg.video).toEqual({
      api: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', apiKey: 'sk-video', model: 'wan2.7-r2v-2026-06-12',
    });
    expect(cfg.tts).toEqual({
      api: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', apiKey: 'sk-tts',
      model: 'qwen3-tts-instruct-flash', voice: 'Cherry',
      instructions: '语速缓慢柔和，声音温柔治愈，像睡前电台在安抚听众，句尾轻轻收住。',
    });
  });

  it('honors per-provider overrides independently', () => {
    const cfg = loadRealProvidersConfig({
      ...baseEnv,
      TEXT_API: 'openai',
      TEXT_BASE_URL: 'https://gw.example.com/v1',
      TEXT_MODEL: 'deepseek-reasoner',
      IMAGE_API: 'openai',
      IMAGE_BASE_URL: 'https://img.example.com/v1',
      IMAGE_MODEL: 'gpt-image-1',
      VIDEO_API: 'newapi',
      VIDEO_BASE_URL: 'https://vid.example.com/v1',
      VIDEO_MODEL: 'kling-v2-1',
      TTS_MODEL: 'qwen3-tts-flash',
      TTS_VOICE: 'Serena',
      TTS_INSTRUCTIONS: '语速偏快，活泼一些。',
    });
    expect(cfg.text).toEqual({ api: 'openai', baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-text', model: 'deepseek-reasoner' });
    expect(cfg.image).toEqual({ api: 'openai', baseUrl: 'https://img.example.com/v1', apiKey: 'sk-image', model: 'gpt-image-1' });
    expect(cfg.video).toEqual({ api: 'newapi', baseUrl: 'https://vid.example.com/v1', apiKey: 'sk-video', model: 'kling-v2-1' });
    expect(cfg.tts).toMatchObject({ model: 'qwen3-tts-flash', voice: 'Serena', instructions: '语速偏快，活泼一些。' });
  });

  it('routes video to the OpenAI-compatible gateway protocol', () => {
    const cfg = loadRealProvidersConfig({ ...baseEnv, VIDEO_API: 'newapi', VIDEO_MODEL: 'veo-3' });
    expect(cfg.video.api).toBe('newapi');
    expect(cfg.video.model).toBe('veo-3');
    // 未覆盖项回退默认端点
    expect(cfg.video.baseUrl).toBe('https://dashscope.aliyuncs.com/api/v1');
  });

  it('lists every missing required key', () => {
    try {
      loadRealProvidersConfig({});
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingEnvError);
      const missing = (err as MissingEnvError).missing;
      for (const key of ['TEXT_API_KEY', 'IMAGE_API_KEY', 'VIDEO_API_KEY', 'TTS_API_KEY']) {
        expect(missing).toContain(key);
      }
    }
  });
});
