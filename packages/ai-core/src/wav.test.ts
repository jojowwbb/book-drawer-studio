import { describe, expect, it } from 'vitest';
import { encodeWav } from './fake/FakeTtsProvider';
import { concatWavs, parseWav } from './wav';

function wavOf(samples: number): Uint8Array {
  return encodeWav(new Int16Array(samples), 24_000);
}

describe('concatWavs', () => {
  it('joins segments with silence gap between them', () => {
    const out = parseWav(concatWavs([wavOf(480), wavOf(720)], 100));
    expect(out.sampleRate).toBe(24_000);
    expect(out.channels).toBe(1);
    // 480 + 720 样本 + 100ms×24000 = 2400 静音
    expect(out.pcm.byteLength / 2).toBe(480 + 720 + 2400);
  });

  it('single segment keeps its length without gap', () => {
    const out = parseWav(concatWavs([wavOf(480)], 250));
    expect(out.pcm.byteLength / 2).toBe(480);
  });

  it('rejects mismatched sample formats', () => {
    const otherRate = encodeWav(new Int16Array(480), 22_050);
    expect(() => concatWavs([wavOf(480), otherRate], 100)).toThrow(/mismatched/);
  });

  it('normalizes loudness so quiet and loud segments end up at the same RMS', () => {
    // 一段安静（幅度 1000）和一段响亮（幅度 30000），归一化后两段 RMS 应接近
    const quiet = new Int16Array(2400);
    const loud = new Int16Array(2400);
    for (let i = 0; i < 2400; i++) {
      quiet[i] = Math.round(1000 * Math.sin((2 * Math.PI * 440 * i) / 24000));
      loud[i] = Math.round(30000 * Math.sin((2 * Math.PI * 440 * i) / 24000));
    }
    const out = parseWav(concatWavs([encodeWav(quiet, 24000), encodeWav(loud, 24000)], 100));
    // 拆出两段（跳过中间静音 gap），算各自 RMS
    const segLen = 2400;
    const gapLen = 2400; // 100ms * 24000
    const dv = new DataView(out.pcm.buffer, out.pcm.byteOffset, out.pcm.byteLength);
    const rms = (start: number, len: number) => {
      let sum = 0;
      for (let i = 0; i < len; i++) {
        const s = dv.getInt16((start + i) * 2, true);
        sum += s * s;
      }
      return Math.sqrt(sum / len);
    };
    const rms1 = rms(0, segLen);
    const rms2 = rms(segLen + gapLen, segLen);
    // 归一化后两段 RMS 应在 10% 以内（目标同为 -20 dBFS）
    expect(Math.abs(rms1 - rms2) / Math.max(rms1, rms2)).toBeLessThan(0.1);
  });
});
