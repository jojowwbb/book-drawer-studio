/**
 * 统一的供应商配置：每个能力（text / image / video / tts）都是独立四元组
 * { api, baseUrl, apiKey, model }，通过 `<前缀>_API` 选择接口协议、
 * `<前缀>_BASE_URL` / `<前缀>_API_KEY` / `<前缀>_MODEL` 覆盖端点、密钥、模型。
 * 前缀分别是 TEXT / IMAGE / VIDEO / TTS，四组互不影响，可分别指向不同厂商或网关。
 */
export interface ProviderConfig {
  /** 接口协议标识（见各 readProvider 的 api 默认值与 providers.ts 的路由） */
  api: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 文本（故事/剧本分析）：走 OpenAI 兼容 /chat/completions，DeepSeek 或任意兼容网关 */
export type StoryProviderConfig = ProviderConfig;
/** 文生图：api = dashscope | openai */
export type ImageProviderConfig = ProviderConfig;
/** 图生视频：api = dashscope | newapi | openai */
export type VideoGenConfig = ProviderConfig;
/** 语音合成：api = dashscope；额外带音色与指令 */
export interface TtsConfig extends ProviderConfig {
  voice: string;
  /** 指令控制（仅 instruct 系模型生效）：自然语言描述语速/情感/风格 */
  instructions?: string;
}

export interface RealProvidersConfig {
  text: StoryProviderConfig;
  image: ImageProviderConfig;
  video: VideoGenConfig;
  tts: TtsConfig;
}

export class MissingEnvError extends Error {
  constructor(readonly missing: string[]) {
    super(`missing required env: ${missing.join(', ')}`);
  }
}

interface ProviderDefaults {
  api: string;
  baseUrl: string;
  model: string;
}

function readProvider(
  env: Record<string, string | undefined>,
  prefix: string,
  defaults: ProviderDefaults,
  missing: string[],
): ProviderConfig {
  const key = `${prefix}_API_KEY`;
  const apiKey = env[key];
  if (!apiKey) missing.push(key);
  return {
    api: env[`${prefix}_API`] || defaults.api,
    baseUrl: env[`${prefix}_BASE_URL`] || defaults.baseUrl,
    apiKey: apiKey || '',
    model: env[`${prefix}_MODEL`] || defaults.model,
  };
}

const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/api/v1';

export function loadRealProvidersConfig(env: Record<string, string | undefined>): RealProvidersConfig {
  const missing: string[] = [];
  const text = readProvider(env, 'TEXT', { api: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' }, missing);
  const image = readProvider(env, 'IMAGE', { api: 'dashscope', baseUrl: DASHSCOPE_BASE, model: 'qwen-image-2.0' }, missing);
  const video = readProvider(env, 'VIDEO', { api: 'dashscope', baseUrl: DASHSCOPE_BASE, model: 'wan2.7-r2v-2026-06-12' }, missing);
  const ttsBase = readProvider(env, 'TTS', { api: 'dashscope', baseUrl: DASHSCOPE_BASE, model: 'qwen3-tts-instruct-flash' }, missing);
  const tts: TtsConfig = {
    ...ttsBase,
    voice: env.TTS_VOICE || 'Cherry',
    // 指令控制（instruct 模型专属）：有声书场景默认慢速治愈旁白；非 instruct 模型下发会被忽略
    instructions: env.TTS_INSTRUCTIONS || '语速缓慢柔和，声音温柔治愈，像睡前电台在安抚听众，句尾轻轻收住。',
  };
  if (missing.length > 0) throw new MissingEnvError(missing);
  return { text, image, video, tts };
}
