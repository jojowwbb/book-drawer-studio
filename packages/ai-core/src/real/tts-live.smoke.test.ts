import { describe, expect, it } from 'vitest';
import { DashScopeTtsProvider } from './DashScopeTtsProvider';

// 真实供应商冒烟测试：仅在 .env 提供 key 时启用（手动 `vitest run --dir src/real` 前 source .env）
const key = process.env.TTS_API_KEY;

describe.skipIf(!key)('DashScopeTtsProvider live smoke', () => {
  it('synthesizes zh narration through the real API', async () => {
    const provider = new DashScopeTtsProvider({
      api: 'dashscope',
      baseUrl: process.env.TTS_BASE_URL ?? 'https://dashscope.aliyuncs.com/api/v1',
      apiKey: key!,
      model: process.env.TTS_MODEL ?? 'qwen3-tts-instruct-flash',
      voice: process.env.TTS_VOICE ?? 'Cherry',
      instructions: process.env.TTS_INSTRUCTIONS || undefined,
    });
    const { audio } = await provider.synthesize({
      text: '天黑了，小兔子躺在软软的床上，眼皮越来越重。',
      lang: 'zh',
    });
    expect(audio.length).toBeGreaterThan(1000);
    expect(Buffer.from(audio.subarray(0, 4)).toString('latin1')).toBe('RIFF');
  }, { timeout: 60000 });
});
