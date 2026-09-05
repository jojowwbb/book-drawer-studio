import { describe, expect, it, vi } from 'vitest';
import { OpenAIVideosProvider } from './OpenAIVideosProvider';
import type { VideoGenConfig } from './config';

const cfg: VideoGenConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-oai',
  model: 'sora-2',
  api: 'openai',
};

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('OpenAIVideosProvider', () => {
  it('submits multipart with input_reference, polls to completed, downloads content', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let pollCount = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, init });
      if (href === 'https://api.openai.com/v1/videos' && init?.method === 'POST') {
        return jsonResponse({ id: 'vid-1', status: 'queued' });
      }
      if (href === 'https://api.openai.com/v1/videos/vid-1') {
        pollCount += 1;
        return jsonResponse({ id: 'vid-1', status: pollCount < 2 ? 'in_progress' : 'completed' });
      }
      return new Response(mp4, { status: 200 });
    });
    const provider = new OpenAIVideosProvider(cfg, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 1,
    });

    const out = await provider.generateClip({ firstFramePng: png, prompt: '夜航的灯塔缓缓旋转', durationSec: 10 });

    expect(Array.from(out.video)).toEqual(Array.from(mp4));
    const create = calls[0]!;
    expect(create.init?.method).toBe('POST');
    expect(create.init?.body).toBeInstanceOf(FormData);
    const form = create.init?.body as FormData;
    expect(form.get('model')).toBe('sora-2');
    expect(form.get('prompt')).toBe('夜航的灯塔缓缓旋转');
    expect(form.get('input_reference')).toBeInstanceOf(Blob);
    expect(pollCount).toBe(2);
    const content = calls[calls.length - 1]!;
    expect(content.url).toBe('https://api.openai.com/v1/videos/vid-1/content');
    const headers = content.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-oai');
  });

  it('throws with API message when the task fails', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === 'https://api.openai.com/v1/videos') return jsonResponse({ id: 'vid-2' });
      return jsonResponse({ status: 'failed', error: { message: 'safety refusal' } });
    });
    const provider = new OpenAIVideosProvider(cfg, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 1,
    });
    await expect(provider.generateClip({ firstFramePng: png, prompt: 'x' })).rejects.toThrow(/safety refusal/);
  });

  it('throws on create HTTP error', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"invalid api key"}', { status: 401 }));
    const provider = new OpenAIVideosProvider(cfg, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 1,
    });
    await expect(provider.generateClip({ firstFramePng: png, prompt: 'x' })).rejects.toThrow(/HTTP 401/);
  });
});
