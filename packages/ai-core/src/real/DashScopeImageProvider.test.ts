import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashScopeImageProvider } from './DashScopeImageProvider';

const PNG_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const IMAGE_URL = 'https://dashscope-result.oss-cn-beijing.aliyuncs.com/a.png';

afterEach(() => vi.restoreAllMocks());

function makeProvider(fetchImpl: unknown): DashScopeImageProvider {
  return new DashScopeImageProvider(
    { api: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', apiKey: 'sk-ds', model: 'qwen-image-2.0' },
    { fetchImpl: fetchImpl as typeof fetch },
  );
}

describe('DashScopeImageProvider', () => {
  it('calls sync multimodal-generation and downloads the result image', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      const headers = init?.headers as Record<string, string>;
      if (urlStr.endsWith('/multimodal-generation/generation') && init?.method === 'POST') {
        expect(headers.authorization).toBe('Bearer sk-ds');
        // 同步接口不得携带异步头
        expect(headers['x-dashscope-async']).toBeUndefined();
        const body = JSON.parse(String(init?.body)) as {
          model: string;
          input: { messages: { role: string; content: { text: string }[] }[] };
          parameters: { size: string; n: number; watermark: boolean; seed: number };
        };
        expect(body.model).toBe('qwen-image-2.0');
        expect(body.input.messages[0]!.content[0]!.text).toContain('暖色水彩');
        expect(body.parameters.size).toBe('2688*1536'); // 16:9 推荐档位
        expect(body.parameters).toMatchObject({ n: 1, watermark: false });
        return new Response(
          JSON.stringify({
            output: {
              choices: [{ message: { content: [{ image: IMAGE_URL }] } }],
            },
            usage: { image_count: 1 },
          }),
          { status: 200 },
        );
      }
      expect(urlStr).toBe(IMAGE_URL);
      return new Response(PNG_BYTES as unknown as BodyInit, { status: 200 });
    });
    const png = await makeProvider(fetchMock).generateImage({
      prompt: '暖色水彩森林', style: 'watercolor', width: 1920, height: 1080, seed: 42,
    });
    expect(png).toEqual(PNG_BYTES);
  });

  it('surfaces the dashscope error body on failure', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ code: 'InvalidParameter', message: 'size not supported' }),
        { status: 400 },
      ),
    );
    await expect(
      makeProvider(fetchMock).generateImage({ prompt: 'x', style: 'flat', width: 64, height: 64, seed: 1 }),
    ).rejects.toThrow(/size not supported/);
  });

  it('throws when the response contains no image', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ text: 'nope' }] } }] } }), { status: 200 }),
    );
    await expect(
      makeProvider(fetchMock).generateImage({ prompt: 'x', style: 'flat', width: 1024, height: 1024, seed: 1 }),
    ).rejects.toThrow(/returned no image/);
  });
});
