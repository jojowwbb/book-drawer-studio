import type { VideoClipRequest, VideoClipResult, VideoGenProvider } from '../types';
import { fetchJson, fetchJsonGet, fetchRaw, type FetchJsonOptions } from './http';
import type { VideoGenConfig } from './config';

interface CreateTaskResponse {
  output?: { task_id?: string; task_status?: string };
  code?: string;
  message?: string;
}

interface TaskResponse {
  output?: {
    task_status?: string;
    video_url?: string;
    code?: string;
    message?: string;
  };
  code?: string;
  message?: string;
}

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/**
 * 阿里百炼万相视频生成（wan2.7 系列），两种模式共用 video-synthesis 端点：
 *
 * - i2v（首帧生视频）：插画同时作为 first_frame 与 last_frame 导入
 *   （画面从插画出发、最终回到插画）。
 * - r2v（参考图生视频）：req.referenceImages 非空时全部作为 reference_image 导入，
 *   顺序即 prompt 中「图N」编号；parameters 带 ratio 与 prompt_extend:false
 *   （防模型改写 prompt 破坏图N 指代）。
 *
 * 异步任务：POST {base}/services/aigc/video-generation/video-synthesis（必须带
 * X-DashScope-Async: enable），轮询 GET {base}/tasks/{task_id}，
 * SUCCEEDED 后下载 output.video_url（链接 24h 有效）。
 */
export class DashScopeVideoProvider implements VideoGenProvider {
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
    const base = this.cfg.baseUrl.replace(/\/$/, '');
    const r2v = !!req.referenceImages && req.referenceImages.length > 0;
    if (!r2v && !req.firstFramePng) {
      throw new Error(`dashscope video request needs referenceImages (r2v) or firstFramePng (i2v) (${this.name})`);
    }

    const media = r2v
      ? req.referenceImages!.map((png) => ({
          type: 'reference_image',
          url: `data:image/png;base64,${toBase64(png)}`,
        }))
      : [
          { type: 'first_frame', url: `data:image/png;base64,${toBase64(req.firstFramePng!)}` },
          {
            type: 'last_frame',
            url: `data:image/png;base64,${toBase64(req.lastFramePng ?? req.firstFramePng!)}`,
          },
        ];

    const created = await fetchJson<CreateTaskResponse>(
      `${base}/services/aigc/video-generation/video-synthesis`,
      {
        model: this.cfg.model,
        input: {
          prompt: req.prompt.slice(0, 5000),
          media,
        },
        parameters: {
          resolution: req.resolution ?? '720P',
          duration: req.durationSec ?? 5,
          watermark: false,
          ...(r2v ? { ratio: req.ratio ?? '16:9', prompt_extend: false } : {}),
          ...(req.seed !== undefined ? { seed: req.seed % 2147483647 } : {}),
        },
      },
      { ...this.http, headers: { ...this.http.headers, 'X-DashScope-Async': 'enable' } },
    );
    const taskId = created.output?.task_id;
    if (!taskId) {
      throw new Error(
        `dashscope video task create failed: ${created.code ?? ''} ${created.message ?? JSON.stringify(created).slice(0, 300)} (${this.name})`,
      );
    }

    const videoUrl = await this.pollTask(`${base}/tasks/${taskId}`);
    return { video: await fetchRaw(videoUrl, { fetchImpl: this.opts.fetchImpl, timeoutMs: 120_000 }) };
  }

  private async pollTask(url: string): Promise<string> {
    const interval = this.opts.pollIntervalMs ?? 15_000;
    const deadline = Date.now() + (this.opts.pollTimeoutMs ?? 600_000);
    for (;;) {
      const res = await fetchJsonGet<TaskResponse>(url, this.http);
      const status = res.output?.task_status;
      if (status === 'SUCCEEDED') {
        const videoUrl = res.output?.video_url;
        if (!videoUrl) throw new Error(`dashscope video task succeeded without video_url (${this.name})`);
        return videoUrl;
      }
      if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
        throw new Error(
          `dashscope video task ${status}: ${res.output?.code ?? res.code ?? ''} ${res.output?.message ?? res.message ?? ''} (${this.name})`,
        );
      }
      if (Date.now() > deadline) throw new Error(`dashscope video task timed out (${this.name})`);
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}
