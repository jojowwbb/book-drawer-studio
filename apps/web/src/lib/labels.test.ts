import { describe, expect, it } from 'vitest';
import { stateLabel } from './labels';

describe('stateLabel', () => {
  it('maps known states to Chinese labels', () => {
    expect(stateLabel('created')).toBe('准备中');
    expect(stateLabel('story_generating')).toBe('故事编写中');
    expect(stateLabel('pages_generating')).toBe('插画与配音生成中');
    expect(stateLabel('ready')).toBe('生成完成');
    expect(stateLabel('enhance_generating')).toBe('视频片段生成中');
    expect(stateLabel('failed_enhance_generating')).toBe('视频片段生成失败');
  });

  it('maps failed states to the stage label + 失败', () => {
    expect(stateLabel('failed_pages_generating')).toBe('插画与配音生成失败');
    expect(stateLabel('failed_story_moderating')).toBe('故事审核失败');
  });

  it('passes unknown states through', () => {
    expect(stateLabel('mystery')).toBe('mystery');
    expect(stateLabel('failed_mystery')).toBe('mystery失败');
  });
});
