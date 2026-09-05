import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleImageProvider } from './OpenAICompatibleImageProvider';

const PNG_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const IMAGE_URL = 'https://cdn.example.com/a.png';

afterEach(() => vi.restoreAllMocks());

function makeProvider(fetchImpl: unknown, model = 'seedream-4'): OpenAICompatibleImageProvider {
  return new OpenAICompatibleImageProvider(
    { api: 'openai', baseUrl: 'https://gateway.example.com/v1/', apiKey: 'sk-oai', model },
    { fetchImpl: fetchImpl as typeof fetch },
  );
}

describe('OpenAICompatibleImageProvider', () => {
  it('posts to /images/generations and downloads the returned url', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr === 'https://gateway.example.com/v1/images/generations' && init?.method === 'POST') {
        const headers = init?.headers as Record<string, string>;
        expect(headers.authorization).toBe('Bearer sk-oai');
        const body = JSON.parse(String(init?.body)) as {
          model: string; prompt: string; n: number; size: string; response_format: string; seed: number;
        };
        expect(body).toMatchObject({
          model: 'seedream-4', n: 1, size: '1536x1024', response_format: 'url', seed: 42,
        });
        expect(body.prompt).toContain('暖色水彩');
        return new Response(JSON.stringify({ data: [{ url: IMAGE_URL }] }), { status: 200 });
      }
      expect(urlStr).toBe(IMAGE_URL);
      return new Response(PNG_BYTES as unknown as BodyInit, { status: 200 });
    });
    const png = await makeProvider(fetchMock).generateImage({
      prompt: '暖色水彩森林', style: 'watercolor', width: 1920, height: 1080, seed: 42,
    });
    expect(png).toEqual(PNG_BYTES);
  });

  it('decodes inline b64_json when the gateway returns no url', async () => {
    const b64 = Buffer.from(PNG_BYTES).toString('base64');
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 }),
    );
    const png = await makeProvider(fetchMock).generateImage({
      prompt: 'x', style: 'flat', width: 1024, height: 1024, seed: 7,
    });
    expect(png).toEqual(PNG_BYTES);
  });

  it('maps square and portrait ratios to supported sizes', async () => {
    const sizes: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sizes.push((JSON.parse(String(init?.body)) as { size: string }).size);
      return new Response(JSON.stringify({ data: [{ url: IMAGE_URL }] }), { status: 200 });
    });
    const dl = vi.fn(async () => new Response(PNG_BYTES as unknown as BodyInit, { status: 200 }));
    const p = makeProvider(vi.fn(async (url, init) =>
      String(url).endsWith('/images/generations') ? fetchMock(url, init) : dl(),
    ) as unknown as typeof fetch);
    await p.generateImage({ prompt: 'x', style: 'flat', width: 1080, height: 1080, seed: 1 });
    await p.generateImage({ prompt: 'x', style: 'flat', width: 1080, height: 1920, seed: 1 });
    expect(sizes).toEqual(['1024x1024', '1024x1536']);
  });

  it('omits seed / response_format for OpenAI-native gpt-image models', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr === 'https://gateway.example.com/v1/images/generations') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).not.toHaveProperty('seed');
        expect(body).not.toHaveProperty('response_format');
        return new Response(JSON.stringify({ data: [{ b64_json: 'gQ==' }] }), { status: 200 });
      }
      return new Response(PNG_BYTES as unknown as BodyInit, { status: 200 });
    });
    await makeProvider(fetchMock, 'gpt-image-1').generateImage({
      prompt: 'x', style: 'flat', width: 1920, height: 1080, seed: 5,
    });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('surfaces the gateway error body on failure', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 400 }),
    );
    await expect(
      makeProvider(fetchMock).generateImage({ prompt: 'x', style: 'flat', width: 64, height: 64, seed: 1 }),
    ).rejects.toThrow(/model not found/);
  });

  it('throws when the response contains no image', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await expect(
      makeProvider(fetchMock).generateImage({ prompt: 'x', style: 'flat', width: 1024, height: 1024, seed: 1 }),
    ).rejects.toThrow(/returned no image/);
  });
});
