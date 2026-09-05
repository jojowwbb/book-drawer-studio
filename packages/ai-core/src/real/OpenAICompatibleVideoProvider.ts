import type { VideoClipRequest, VideoClipResult, VideoGenProvider } from '../types';
import { fetchJson, fetchJsonGet, fetchRaw, type FetchJsonOptions } from './http';
import type { VideoGenConfig } from './config';

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

interface CreateResponse {
  id?: string;
  task_id?: string;
  status?: string;
  error?: { message?: string };
  message?: string;
}

interface PollResponse {
  status?: string;
  video_url?: string;
  data?: { url?: string }[];
  error?: { message?: string };
  message?: string;
}

/**
 * OpenAI 兼容网关的图生视频任务式接口（new-api / one-api 等普遍兼容的约定）：
 * - 提交：POST {baseUrl}/video/generations，body {model, prompt, image(首帧 data URL), duration, seed...}
 *   → { id | task_id }
 * - 轮询：GET {baseUrl}/video/generations/{task_id}
 *   → { status: pending|running|succeeded|completed|failed, video_url | data[0].url }
 *
 * baseUrl 与 IMAGE_BASE_URL 同风格（含 /v1），如 https://gateway.example.com/v1。
 * 网关背后可以代理 Kling / 即梦 / Veo 等任意视频模型，只需换 VIDEO_MODEL。
 */
export class OpenAICompatibleVideoProvider implements VideoGenProvider {
  readonly name: string;

  constructor(
    private readonly cfg: VideoGenConfig,
    private readonly opts: {
      fetchImpl?: typeof fetch;
      pollIntervalMs?: number;
      pollTimeoutMs?: number;
    } = {},
  ) {
    this.name = `video:${cfg.model}`;
  }

  private get http(): FetchJsonOptions {
    return {
      fetchImpl: this.opts.fetchImpl,
      timeoutMs: 60_000,
      headers: { authorization: `Bearer ${this.cfg.apiKey}` },
    };
  }

  async generateClip(req: VideoClipRequest): Promise<VideoClipResult> {
    // 兼容网关只支持首帧 i2v 约定，无参考图（r2v）协议
    if (!req.firstFramePng) {
      throw new Error(`provider does not support reference-image (r2v) mode; use VIDEO_API=dashscope (${this.name})`);
    }
    const base = this.cfg.baseUrl.replace(/\/$/, '');
    const created = await fetchJson<CreateResponse>(
      `${base}/video/generations`,
      {
        model: this.cfg.model,
        prompt: req.prompt.slice(0, 5000),
        image: `data:image/png;base64,${toBase64(req.firstFramePng)}`,
        ...(req.lastFramePng ? { last_image: `data:image/png;base64,${toBase64(req.lastFramePng)}` } : {}),
        duration: req.durationSec ?? 5,
        ...(req.resolution ? { size: req.resolution } : {}),
        ...(req.seed !== undefined ? { seed: req.seed % 2147483647 } : {}),
      },
      this.http,
    );
    const taskId = created.id ?? created.task_id;
    if (!taskId) {
      throw new Error(
        `video task create failed: ${created.error?.message ?? created.message ?? JSON.stringify(created).slice(0, 300)} (${this.name})`,
      );
    }

    const videoUrl = await this.pollTask(`${base}/video/generations/${taskId}`);
    return { video: await fetchRaw(videoUrl, { fetchImpl: this.opts.fetchImpl, timeoutMs: 120_000 }) };
  }

  private async pollTask(url: string): Promise<string> {
    const interval = this.opts.pollIntervalMs ?? 15_000;
    const deadline = Date.now() + (this.opts.pollTimeoutMs ?? 600_000);
    for (;;) {
      const res = await fetchJsonGet<PollResponse>(url, this.http);
      const status = (res.status ?? '').toLowerCase();
      if (status === 'succeeded' || status === 'completed') {
        const videoUrl = res.video_url ?? res.data?.[0]?.url;
        if (!videoUrl) throw new Error(`video task succeeded without video_url (${this.name})`);
        return videoUrl;
      }
      if (status === 'failed' || status === 'cancelled' || status === 'error') {
        throw new Error(
          `video task ${status}: ${res.error?.message ?? res.message ?? 'no detail'} (${this.name})`,
        );
      }
      if (Date.now() > deadline) throw new Error(`video task timed out (${this.name})`);
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}
