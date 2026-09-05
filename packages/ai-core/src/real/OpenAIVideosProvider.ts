import type { VideoClipRequest, VideoClipResult, VideoGenProvider } from '../types';
import { fetchJsonGet, fetchRaw, type FetchJsonOptions } from './http';
import type { VideoGenConfig } from './config';

interface CreateVideoResponse {
  id?: string;
  status?: string;
  error?: { message?: string };
}

/**
 * OpenAI 官方视频接口（Sora 系列）：
 * - 提交：POST {baseUrl}/videos，multipart 表单 {model, prompt, input_reference(首帧 png)}
 * - 轮询：GET {baseUrl}/videos/{id} → status: queued|in_progress|completed|failed
 * - 下载：GET {baseUrl}/videos/{id}/content（mp4 字节流）
 *
 * baseUrl 如 https://api.openai.com/v1。仅支持首帧导入（无尾帧/seed 参数）。
 */
export class OpenAIVideosProvider implements VideoGenProvider {
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
    // Sora 系列只支持 input_reference 首帧导入，无参考图（r2v）协议
    if (!req.firstFramePng) {
      throw new Error(`provider does not support reference-image (r2v) mode; use VIDEO_API=dashscope (${this.name})`);
    }
    const base = this.cfg.baseUrl.replace(/\/$/, '');
    const form = new FormData();
    form.append('model', this.cfg.model);
    form.append('prompt', req.prompt.slice(0, 5000));
    form.append(
      'input_reference',
      new Blob([req.firstFramePng as unknown as Uint8Array<ArrayBuffer>], { type: 'image/png' }),
      'first_frame.png',
    );

    const doFetch = this.opts.fetchImpl ?? globalThis.fetch;
    const createdRes = await doFetch(`${base}/videos`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.cfg.apiKey}` },
      body: form,
    });
    if (!createdRes.ok) {
      const body = await createdRes.text().catch(() => '');
      throw new Error(`openai video create failed: HTTP ${createdRes.status} ${body.slice(0, 300)} (${this.name})`);
    }
    const created = (await createdRes.json()) as CreateVideoResponse;
    if (!created.id) {
      throw new Error(
        `openai video create returned no id: ${created.error?.message ?? JSON.stringify(created).slice(0, 300)} (${this.name})`,
      );
    }

    await this.pollTask(`${base}/videos/${created.id}`);
    return {
      video: await fetchRaw(`${base}/videos/${created.id}/content`, {
        ...this.http,
        timeoutMs: 120_000,
      }),
    };
  }

  private async pollTask(url: string): Promise<void> {
    const interval = this.opts.pollIntervalMs ?? 15_000;
    const deadline = Date.now() + (this.opts.pollTimeoutMs ?? 600_000);
    for (;;) {
      const res = await fetchJsonGet<CreateVideoResponse>(url, this.http);
      if (res.status === 'completed') return;
      if (res.status === 'failed' || res.status === 'cancelled') {
        throw new Error(`openai video task ${res.status}: ${res.error?.message ?? 'no detail'} (${this.name})`);
      }
      if (Date.now() > deadline) throw new Error(`openai video task timed out (${this.name})`);
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}
