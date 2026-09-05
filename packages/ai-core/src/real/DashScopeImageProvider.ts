import type { ImageProvider, ImageRequest } from '../types';
import { fetchJson, fetchRaw, type FetchJsonOptions } from './http';
import type { ImageProviderConfig } from './config';

interface QwenImageResponse {
  output?: {
    choices?: {
      message?: {
        content?: { image?: string }[];
      };
    }[];
  };
  code?: string;
  message?: string;
}

/**
 * 阿里百炼千问图像（qwen-image 系列）文生图：同步 multimodal-generation 接口。
 * 图片 URL 位于响应 output.choices[0].message.content[0].image（24 小时有效，需及时下载）。
 *
 * size 使用百炼推荐的固定档位（书页为 16:9）：
 * - qwen-image-2.0 系列 16:9 → 2688*1536
 * - qwen-image / max / plus 16:9 → 1664*928
 */
export class DashScopeImageProvider implements ImageProvider {
  readonly name: string;

  constructor(
    private readonly cfg: ImageProviderConfig,
    private readonly opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
  ) {
    this.name = `image:${cfg.model}`;
  }

  private sizeParameter(width: number, height: number): string {
    const ratio = width / height;
    const is16x9 = Math.abs(ratio - 16 / 9) < 0.02;
    const is1x1 = Math.abs(ratio - 1) < 0.02;
    const is2x = this.cfg.model.includes('2.0');
    if (is16x9) return is2x ? '2688*1536' : '1664*928';
    if (is1x1) return is2x ? '2048*2048' : '1328*1328';
    if (is2x) return ratio > 1 ? '2368*1728' : '1728*2368';
    return ratio > 1 ? '1472*1104' : '1104*1472';
  }

  async generateImage(req: ImageRequest): Promise<Uint8Array> {
    const base = this.cfg.baseUrl.replace(/\/$/, '');
    const o: FetchJsonOptions = {
      fetchImpl: this.opts.fetchImpl,
      timeoutMs: this.opts.timeoutMs ?? 120_000,
      headers: { authorization: `Bearer ${this.cfg.apiKey}` },
    };
    const res = await fetchJson<QwenImageResponse>(
      `${base}/services/aigc/multimodal-generation/generation`,
      {
        model: this.cfg.model,
        input: {
          messages: [{ role: 'user', content: [{ text: req.prompt }] }],
        },
        parameters: {
          size: this.sizeParameter(req.width, req.height),
          n: 1,
          watermark: false,
          ...(req.seed !== undefined ? { seed: req.seed % 2147483647 } : {}),
        },
      },
      o,
    );
    const content = res.output?.choices?.[0]?.message?.content ?? [];
    const url = content.find((c) => typeof c.image === 'string')?.image;
    if (!url) {
      throw new Error(
        `dashscope image generation returned no image: ${res.code ?? ''} ${res.message ?? JSON.stringify(res).slice(0, 300)} (${this.name})`,
      );
    }
    return fetchRaw(url, { fetchImpl: this.opts.fetchImpl, timeoutMs: 120_000 });
  }
}
