import type { Emotion } from './story-schema';
import type { Lang } from './types';

/**
 * 每页情绪 → TTS 自然语言语气指令（qwen3-tts-instruct 系模型消费）。
 *
 * 剧本创作阶段 AI 已为每页标注 emotion（与旁白遣词语气一致的朗读语气），
 * 配音时把该页 emotion 映射成 per-request instructions，与全局
 * TTS_INSTRUCTIONS（整体基调）叠加下发——tense 页自动压低放快、
 * sleepy 页自动轻柔拖长，让配音贴合情节而不是全篇一个腔调。
 */
const EMOTION_TONE: Record<Emotion, { zh: string; en: string }> = {
  calm: {
    zh: '语气平和舒缓，像日常讲故事一样自然从容。',
    en: 'Speak in a calm, relaxed storytelling tone.',
  },
  joyful: {
    zh: '语气轻快明亮，带着笑意，语调微微上扬，节奏稍快。',
    en: 'Speak in a bright, cheerful tone with a smile, slightly faster.',
  },
  tense: {
    zh: '声音压低、语速稍快，带一点紧张的呼吸感，营造悬念。',
    en: 'Lower the voice slightly and speak a bit faster, with a hint of suspenseful tension.',
  },
  sad: {
    zh: '语调低缓温柔，带着心疼与安慰感，句与句之间稍作停顿。',
    en: 'Speak softly and slowly, gently melancholic, with small pauses between phrases.',
  },
  wonder: {
    zh: '语气好奇惊喜，像发现了新事物，尾音微微上扬。',
    en: 'Speak with curiosity and delight, as if discovering something new, rising slightly at the end.',
  },
  sleepy: {
    zh: '声音轻柔拖长，像哄睡一样越来越慢越来越轻，句尾轻轻收住。',
    en: 'Speak very softly and slowly, like soothing a child to sleep, fading gently at sentence ends.',
  },
};

/** 该页配音的语气指令（与全局基调指令叠加下发）；未知情绪返回 undefined 走全局 */
export function emotionInstructions(emotion: Emotion | string | undefined, lang: Lang): string | undefined {
  if (!emotion) return undefined;
  const tone = EMOTION_TONE[emotion as Emotion];
  return tone ? tone[lang] : undefined;
}
