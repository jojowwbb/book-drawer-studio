import type { ProjectProviders, ProviderBundle } from '../types';
import { FakeImageProvider } from './FakeImageProvider';
import { FakeMattingProvider } from './FakeMattingProvider';
import { FakeModerationProvider, type FakeModerationOptions } from './FakeModerationProvider';
import { FakeScriptProvider } from './FakeScriptProvider';
import { FakeStoryProvider } from './FakeStoryProvider';
import { FakeTtsProvider } from './FakeTtsProvider';
import { FakeVideoClipProvider } from './FakeVideoClipProvider';

export interface FakeProvidersOptions {
  moderation?: FakeModerationOptions;
}

export function createFakeProviders(opts: FakeProvidersOptions = {}): ProviderBundle {
  return {
    story: new FakeStoryProvider(),
    image: new FakeImageProvider(),
    matting: new FakeMattingProvider(),
    tts: new FakeTtsProvider(),
    moderation: new FakeModerationProvider(opts.moderation),
  };
}

/** 故事视频产线 Fake 桩（端到端测试用） */
export function createFakeProjectProviders(opts: FakeProvidersOptions = {}): ProjectProviders {
  return {
    script: new FakeScriptProvider(),
    image: new FakeImageProvider(),
    videoClip: new FakeVideoClipProvider(),
    tts: new FakeTtsProvider(),
    moderation: new FakeModerationProvider(opts.moderation),
  };
}
