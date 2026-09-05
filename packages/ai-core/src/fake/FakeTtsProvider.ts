import type { TtsProvider, TtsRequest, TtsResult } from '../types';
import { hashSeed } from './rng';

/** 16-bit PCM 单声道 WAV 封装（e2e/单测的确定性假音频） */
export function encodeWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // channels
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i]!, 44 + i * 2);
  return new Uint8Array(buf);
}

const SAMPLE_RATE = 24_000;

/**
 * 确定性假 TTS：按文本哈希派生音高，时长 ≈ 0.6s + 70ms/字（上限 8s），
 * 产出可被浏览器与 ffmpeg 正常解码的正弦波 WAV。
 */
export class FakeTtsProvider implements TtsProvider {
  readonly name = 'fake-tts';

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    const seed = hashSeed(req.text);
    const freq = 180 + (seed % 220);
    const durationSec = Math.min(8, 0.6 + req.text.length * 0.07);
    const count = Math.round(durationSec * SAMPLE_RATE);
    const samples = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      const t = i / SAMPLE_RATE;
      // 首尾淡入淡出各 30ms，避免爆音
      const edge = Math.min(1, t / 0.03, (durationSec - t) / 0.03);
      samples[i] = Math.round(Math.sin(2 * Math.PI * freq * t) * 12_000 * edge);
    }
    return { audio: encodeWav(samples, SAMPLE_RATE) };
  }
}
