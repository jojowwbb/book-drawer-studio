import type { TtsProvider, TtsRequest, TtsResult } from '../types';
import { fetchJson, fetchRaw, type FetchJsonOptions } from './http';
import type { TtsConfig } from './config';

interface TtsResponse {
  output?: {
    audio?: { url?: string; data?: string };
    code?: string;
    message?: string;
  };
  code?: string;
  message?: string;
}

const LANGUAGE_TYPE: Record<string, string> = {
  zh: 'Chinese',
  en: 'English',
};

/**
 * 阿里百炼 Qwen-TTS 非实时语音合成（qwen3-tts 系列）。
 *
 * 同步接口：POST {base}/services/aigc/multimodal-generation/generation，
 * 响应 output.audio.url 为合成音频（wav）下载链接（24h 有效），立即下载落盘。
 * 旁白逐页合成（单页台词远小于 512 token 上限），无需异步任务轮询。
 */
export class DashScopeTtsProvider implements TtsProvider {
  readonly name: string;

  constructor(
    private readonly cfg: TtsConfig,
    private readonly opts: { fetchImpl?: typeof fetch } = {},
  ) {
    this.name = `tts:${cfg.model}`;
  }

  private get http(): FetchJsonOptions {
    return {
      fetchImpl: this.opts.fetchImpl,
      timeoutMs: 60_000,
      headers: { authorization: `Bearer ${this.cfg.apiKey}` },
    };
  }

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    const base = this.cfg.baseUrl.replace(/\/$/, '');
    const input: Record<string, unknown> = {
      text: req.text.slice(0, 2000),
      voice: req.voice ?? this.cfg.voice,
      language_type: LANGUAGE_TYPE[req.lang] ?? 'Auto',
    };
    // 指令控制仅 instruct 系模型支持：慢速/情感等表现力通过自然语言指令下发。
    // 全局基调（cfg.instructions，如慢速治愈）与请求级语气（req.instructions，
    // 如该页情绪的朗读语气）叠加合并为一条。
    const instructions = [this.cfg.instructions, req.instructions].filter(Boolean).join('');
    if (instructions && this.cfg.model.includes('instruct')) {
      input.instructions = instructions;
      input.optimize_instructions = true;
    }
    const res = await fetchJson<TtsResponse>(
      `${base}/services/aigc/multimodal-generation/generation`,
      {
        model: this.cfg.model,
        input,
      },
      this.http,
    );
    const audioUrl = res.output?.audio?.url;
    if (!audioUrl) {
      throw new Error(
        `dashscope tts failed: ${res.output?.code ?? res.code ?? ''} ${res.output?.message ?? res.message ?? JSON.stringify(res).slice(0, 300)} (${this.name})`,
      );
    }
    return { audio: await fetchRaw(audioUrl, { fetchImpl: this.opts.fetchImpl, timeoutMs: 120_000 }) };
  }
}
