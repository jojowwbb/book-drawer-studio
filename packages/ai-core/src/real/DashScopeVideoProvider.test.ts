import { describe, expect, it, vi } from 'vitest';
import { DashScopeVideoProvider } from './DashScopeVideoProvider';
import type { VideoGenConfig } from './config';

const cfg: VideoGenConfig = {
  api: 'dashscope',
  baseUrl: 'https://dashscope.example.com/api/v1',
  apiKey: 'sk-test',
  model: 'wan2.7-i2v-2026-04-25',
};

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('DashScopeVideoProvider', () => {
  it('submits first+last frame media with prompt, polls the task, downloads the video', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let pollCount = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, init });
      if (href.endsWith('/video-generation/video-synthesis')) {
        return jsonResponse({ output: { task_id: 't-1', task_status: 'PENDING' } });
      }
      if (href.endsWith('/tasks/t-1')) {
        pollCount += 1;
        return jsonResponse(
          pollCount < 2
            ? { output: { task_status: 'RUNNING' } }
            : { output: { task_status: 'SUCCEEDED', video_url: 'https://cdn.example.com/v.mp4' } },
        );
      }
      return new Response(mp4, { status: 200 });
    });
    const provider = new DashScopeVideoProvider(cfg, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 1,
    });

    const out = await provider.generateClip({
      firstFramePng: png,
      prompt: '小兔子推开木门。旁白：门开了，外面是白白的雪。',
      durationSec: 5,
      seed: 7,
    });

    expect(Array.from(out.video)).toEqual(Array.from(mp4));
    const create = calls[0]!;
    const headers = create.init?.headers as Record<string, string>;
    expect(headers['X-DashScope-Async']).toBe('enable');
    expect(headers.authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(create.init?.body)) as {
      model: string;
      input: { prompt: string; media: { type: string; url: string }[] };
      parameters: Record<string, unknown>;
    };
    expect(body.model).toBe('wan2.7-i2v-2026-04-25');
    // 缺省尾帧时复用首帧：画面从插画出发再回到插画
    expect(body.input.media.map((m) => m.type)).toEqual(['first_frame', 'last_frame']);
    expect(body.input.media[0]!.url).toBe(`data:image/png;base64,${Buffer.from(png).toString('base64')}`);
    expect(body.input.media[1]!.url).toBe(body.input.media[0]!.url);
    expect(body.input.prompt).toContain('旁白');
    expect(body.parameters).toMatchObject({ resolution: '720P', duration: 5, watermark: false, seed: 7 });
    expect(pollCount).toBe(2);
  });

  it('passes an explicit last frame when provided', async () => {
    let submitted: { input: { media: { url: string }[] } } | undefined;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/video-generation/video-synthesis')) {
        submitted = JSON.parse(String(init?.body)) as never;
        return jsonResponse({ output: { task_id: 't-2' } });
      }
      if (href.endsWith('/tasks/t-2')) {
        return jsonResponse({ output: { task_status: 'SUCCEEDED', video_url: 'https://cdn/v.mp4' } });
      }
      return new Response(mp4, { status: 200 });
    });
    const provider = new DashScopeVideoProvider(cfg, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 1,
    });
    await provider.generateClip({ firstFramePng: png, lastFramePng: new Uint8Array([1, 2, 3]), prompt: 'x' });
    const urls = submitted!.input.media.map((m) => m.url);
    expect(new Set(urls).size).toBe(2);
  });

  it('throws with provider message when the task fails', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/video-generation/video-synthesis')) {
        return jsonResponse({ output: { task_id: 't-3' } });
      }
      return jsonResponse({ output: { task_status: 'FAILED', code: 'AlgoError', message: 'gen failed' } });
    });
    const provider = new DashScopeVideoProvider(cfg, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 1,
    });
    await expect(provider.generateClip({ firstFramePng: png, prompt: 'x' })).rejects.toThrow(
      /FAILED.*AlgoError gen failed/,
    );
  });

  it('throws when task creation returns no task_id', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ code: 'Throttling', message: 'too many requests' }),
    );
    const provider = new DashScopeVideoProvider(cfg, { fetchImpl: fetchMock as unknown as typeof fetch });
    await expect(provider.generateClip({ firstFramePng: png, prompt: 'x' })).rejects.toThrow(
      /too many requests/,
    );
  });
});
