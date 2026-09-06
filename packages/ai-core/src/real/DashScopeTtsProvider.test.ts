import { describe, expect, it, vi } from 'vitest';
import { DashScopeTtsProvider } from './DashScopeTtsProvider';
import type { TtsConfig } from './config';

const cfg: TtsConfig = {
  api: 'dashscope',
  baseUrl: 'https://dashscope.example.com/api/v1',
  apiKey: 'sk-test',
  model: 'qwen3-tts-flash',
  voice: 'Cherry',
};

const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46]);

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('DashScopeTtsProvider', () => {
  it('posts text+voice, downloads the returned audio url', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, init });
      if (href.endsWith('/multimodal-generation/generation')) {
        return jsonResponse({ output: { audio: { url: 'https://cdn.example.com/a.wav' } } });
      }
      return new Response(wav, { status: 200 });
    });
    const provider = new DashScopeTtsProvider(cfg, { fetchImpl: fetchMock as unknown as typeof fetch });

    const out = await provider.synthesize({ text: '门开了，外面是白白的雪。', lang: 'zh' });

    expect(Array.from(out.audio)).toEqual(Array.from(wav));
    const req = calls[0]!;
    const headers = req.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(req.init?.body)) as {
      model: string;
      input: { text: string; voice: string; language_type: string };
    };
    expect(body.model).toBe('qwen3-tts-flash');
    expect(body.input.text).toBe('门开了，外面是白白的雪。');
    expect(body.input.voice).toBe('Cherry');
    expect(body.input.language_type).toBe('Chinese');
    expect(req.url).toBe('https://dashscope.example.com/api/v1/services/aigc/multimodal-generation/generation');
  });

  it('honors per-request voice and maps lang to language_type', async () => {
    let sent: { input: { voice: string; language_type: string } } | undefined;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/generation')) {
        sent = JSON.parse(String(init?.body)) as never;
        return jsonResponse({ output: { audio: { url: 'https://cdn/a.wav' } } });
      }
      return new Response(wav, { status: 200 });
    });
    const provider = new DashScopeTtsProvider(cfg, { fetchImpl: fetchMock as unknown as typeof fetch });
    await provider.synthesize({ text: 'Once upon a time.', lang: 'en', voice: 'Serena' });
    expect(sent!.input.voice).toBe('Serena');
    expect(sent!.input.language_type).toBe('English');
  });

  it('throws with provider message when no audio url returned', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ code: 'InvalidParameter', message: 'voice not found' }),
    );
    const provider = new DashScopeTtsProvider(cfg, { fetchImpl: fetchMock as unknown as typeof fetch });
    await expect(provider.synthesize({ text: 'x', lang: 'zh' })).rejects.toThrow(/voice not found/);
  });

  it('sends instructions + optimize_instructions for instruct models only', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/generation')) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse({ output: { audio: { url: 'https://cdn/a.wav' } } });
      }
      return new Response(wav, { status: 200 });
    });
    const instruct = new DashScopeTtsProvider(
      { ...cfg, model: 'qwen3-tts-instruct-flash', instructions: '语速缓慢柔和。' },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    await instruct.synthesize({ text: 'a', lang: 'zh' });
    const input1 = (bodies[0] as { input: Record<string, unknown> }).input;
    expect(input1.instructions).toBe('语速缓慢柔和。');
    expect(input1.optimize_instructions).toBe(true);

    const plain = new DashScopeTtsProvider(
      { ...cfg, instructions: '语速缓慢柔和。' },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    await plain.synthesize({ text: 'a', lang: 'zh' });
    const input2 = (bodies[1] as { input: Record<string, unknown> }).input;
    expect(input2.instructions).toBeUndefined();
    expect(input2.optimize_instructions).toBeUndefined();
  });

  it('merges per-request tone instructions after the global base', async () => {
    let sent: { input: Record<string, unknown> } | undefined;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/generation')) {
        sent = JSON.parse(String(init?.body)) as never;
        return jsonResponse({ output: { audio: { url: 'https://cdn/a.wav' } } });
      }
      return new Response(wav, { status: 200 });
    });
    const provider = new DashScopeTtsProvider(
      { ...cfg, model: 'qwen3-tts-instruct-flash', instructions: '语速缓慢柔和。' },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    await provider.synthesize({ text: '雪停了。', lang: 'zh', instructions: '语气好奇惊喜。' });
    expect(sent!.input.instructions).toBe('语速缓慢柔和。语气好奇惊喜。');
    // 无全局基调时单独下发请求级指令
    const bare = new DashScopeTtsProvider(
      { ...cfg, model: 'qwen3-tts-instruct-flash' },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    await bare.synthesize({ text: 'x', lang: 'zh', instructions: '声音压低。' });
    expect(sent!.input.instructions).toBeTruthy();
  });
});
