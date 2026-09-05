import type { ImageProvider, ImageRequest } from '../types';
import { fetchJson, fetchRaw, type FetchJsonOptions } from './http';
import type { ImageProviderConfig } from './config';

interface ImagesGenerationsResponse {
  data?: { url?: string; b64_json?: string }[];
  error?: { message?: string };
}

/**
 * OpenAI Images API 兼容文生图：POST {baseUrl}/images/generations。
 * 可对接 OpenAI 官方（gpt-image-1 / dall-e-3）或任何兼容网关（new-api、one-api 等），
 * 通过 IMAGE_BASE_URL / IMAGE_API_KEY / IMAGE_MODEL 切换供应商。
 * 响应取 data[0].url（下载）或 data[0].b64_json（内联解码）。
 */
export class OpenAICompatibleImageProvider implements ImageProvider {
  readonly name: string;

  constructor(
    private readonly cfg: ImageProviderConfig,
    private readonly opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
  ) {
    this.name = `image:${cfg.model}`;
  }

  /** OpenAI 官方仅支持固定档位，按宽高比就近选择（渲染端 cover 裁切补齐 16:9） */
  private sizeParameter(width: number, height: number): string {
    const ratio = width / height;
    if (Math.abs(ratio - 1) < 0.02) return '1024x1024';
    return ratio > 1 ? '1536x1024' : '1024x1536';
  }

  /** OpenAI 原生模型不接受 seed / response_format 参数（传了会 400），按模型名自动省略 */
  private isOpenAiNativeModel(): boolean {
    return this.cfg.model.startsWith('gpt-image') || this.cfg.model.startsWith('dall-e');
  }

  async generateImage(req: ImageRequest): Promise<Uint8Array> {
    const base = this.cfg.baseUrl.replace(/\/$/, '');
    const o: FetchJsonOptions = {
      fetchImpl: this.opts.fetchImpl,
      timeoutMs: this.opts.timeoutMs ?? 180_000,
      headers: { authorization: `Bearer ${this.cfg.apiKey}` },
    };
    const native = this.isOpenAiNativeModel();
    const res = await fetchJson<ImagesGenerationsResponse>(
      `${base}/images/generations`,
      {
        model: this.cfg.model,
        prompt: req.prompt,
        n: 1,
        size: this.sizeParameter(req.width, req.height),
        ...(native
          ? {}
          : {
              response_format: 'url',
              ...(req.seed !== undefined ? { seed: req.seed % 2147483647 } : {}),
            }),
      },
      o,
    );
    const item = res.data?.[0];
    if (item?.url) {
      return fetchRaw(item.url, { fetchImpl: this.opts.fetchImpl, timeoutMs: 120_000 });
    }
    if (item?.b64_json) {
      return Uint8Array.from(Buffer.from(item.b64_json, 'base64'));
    }
    throw new Error(
      `openai-compatible image generation returned no image: ${res.error?.message ?? JSON.stringify(res).slice(0, 300)} (${this.name})`,
    );
  }
}
