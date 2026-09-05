import type { ProjectProviders, ProviderBundle, VideoGenProvider } from '../types';
import { FakeModerationProvider } from '../fake/FakeModerationProvider';
import type { RealProvidersConfig } from './config';
import { DashScopeImageProvider } from './DashScopeImageProvider';
import { OpenAICompatibleImageProvider } from './OpenAICompatibleImageProvider';
import { DashScopeTtsProvider } from './DashScopeTtsProvider';
import { DashScopeVideoProvider } from './DashScopeVideoProvider';
import { OpenAICompatibleVideoProvider } from './OpenAICompatibleVideoProvider';
import { OpenAIVideosProvider } from './OpenAIVideosProvider';
import { IdentityMattingProvider } from './IdentityMattingProvider';
import { OpenAICompatibleScriptProvider } from './OpenAICompatibleScriptProvider';
import { OpenAICompatibleStoryProvider } from './OpenAICompatibleStoryProvider';

export interface RealProviderOptions {
  fetchImpl?: typeof fetch;
}

export function createRealProviders(
  config: RealProvidersConfig,
  opts: RealProviderOptions = {},
): ProviderBundle {
  return {
    story: new OpenAICompatibleStoryProvider(config.text, opts),
    image: createImageProvider(config, opts),
    matting: new IdentityMattingProvider(),
    tts: new DashScopeTtsProvider(config.tts, opts),
    moderation: new FakeModerationProvider(),
  };
}

/** 故事视频产线真实供应商（剧本分析复用 text 配置） */
export function createRealProjectProviders(
  config: RealProvidersConfig,
  opts: RealProviderOptions = {},
): ProjectProviders {
  return {
    script: new OpenAICompatibleScriptProvider(config.text, opts),
    image: createImageProvider(config, opts),
    videoClip: createVideoProvider(config, opts),
    tts: new DashScopeTtsProvider(config.tts, opts),
    moderation: new FakeModerationProvider(),
  };
}

/** 按 IMAGE_API 选择文生图协议：dashscope（默认，百炼原生）| openai（OpenAI 兼容 /images/generations） */
function createImageProvider(
  config: RealProvidersConfig,
  opts: RealProviderOptions,
): DashScopeImageProvider | OpenAICompatibleImageProvider {
  return config.image.api === 'openai'
    ? new OpenAICompatibleImageProvider(config.image, opts)
    : new DashScopeImageProvider(config.image, opts);
}

/** 按 VIDEO_API 选择视频接口协议：dashscope（默认）| newapi（OpenAI 兼容网关）| openai（官方 /v1/videos） */
function createVideoProvider(
  config: RealProvidersConfig,
  opts: RealProviderOptions,
): VideoGenProvider {
  switch (config.video.api) {
    case 'newapi':
      return new OpenAICompatibleVideoProvider(config.video, opts);
    case 'openai':
      return new OpenAIVideosProvider(config.video, opts);
    default:
      return new DashScopeVideoProvider(config.video, opts);
  }
}
