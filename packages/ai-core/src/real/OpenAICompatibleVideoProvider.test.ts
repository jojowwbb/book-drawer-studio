import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleVideoProvider } from './OpenAICompatibleVideoProvider';
import type { VideoGenConfig } from './config';

const cfg: VideoGenConfig = {
  baseUrl: 'https://gateway.example.com/v1',
  apiKey: 'sk-gw',
  model: 'kling-v2-1',
  api: 'newapi',
};

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('OpenAICompatibleVideoProvider', () => {
  it('submits first frame as data URL, polls the task, downloads the video', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let pollCount = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, init });
      if (href === 'https://gateway.example.com/v1/video/generations') {
        return jsonResponse({ id: 'v-1', status: 'pending' });
      }
      if (href === 'https://gateway.example.com/v1/video/generations/v-1') {
        pollCount += 1;
        return jsonResponse(
          pollCount < 2
            ? { status: 'running' }
            : { status: 'succeeded', video_url: 'https://cdn.example.com/v.mp4' },
        );
      }
      return new Response(mp4, { status: 200 });
    });
    const provider = new OpenAICompatibleVideoProvider(cfg, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 1,
    });

    const out = await provider.generateClip({
      firstFramePng: png,
      prompt: '镜头缓缓推近。旁白：门开了。',
      durationSec: 8,
      seed: 3,
    });

    expect(Array.from(out.video)).toEqual(Array.from(mp4));
    const create = calls[0]!;
    const headers = create.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-gw');
    const body = JSON.parse(String(create.init?.body)) as Record<string, unknown>;
    expect(body.model).toBe('kling-v2-1');
    expect(body.image).toBe(`data:image/png;base64,${Buffer.from(png).toString('base64')}`);
    expect(body.duration).toBe(8);
    expect(body.seed).toBe(3);
    expect(body.last_image).toBeUndefined();
    expect(pollCount).toBe(2);
  });

  it('accepts data[0].url completion shape and treats completed as terminal success', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === 'https://gateway.example.com/v1/video/generations') return jsonResponse({ task_id: 'v-2' });
      if (href.startsWith('https://cdn/')) return new Response(mp4, { status: 200 });
      return jsonResponse({ status: 'completed', data: [{ url: 'https://cdn/v2.mp4' }] });
    });
    const provider = new OpenAICompatibleVideoProvider(cfg, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 1,
    });
    const out = await provider.generateClip({ firstFramePng: png, prompt: 'x' });
    expect(Array.from(out.video)).toEqual(Array.from(mp4));
  });

  it('throws with gateway message when the task fails', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/video/generations')) return jsonResponse({ id: 'v-3' });
      return jsonResponse({ status: 'failed', error: { message: 'content policy' } });
    });
    const provider = new OpenAICompatibleVideoProvider(cfg, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 1,
    });
    await expect(provider.generateClip({ firstFramePng: png, prompt: 'x' })).rejects.toThrow(
      /failed.*content policy/,
    );
  });

  it('throws when create returns no id', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: 'no quota' } }));
    const provider = new OpenAICompatibleVideoProvider(cfg, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(provider.generateClip({ firstFramePng: png, prompt: 'x' })).rejects.toThrow(/no quota/);
  });
});
