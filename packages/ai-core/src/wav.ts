/**
 * 轻量 WAV（PCM）工具：解析头部、按字节拼接、生成静音段。
 * 用于把分角色配音的各段音频拼成一页完整旁白。
 */

export interface WavData {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** PCM 数据字节 */
  pcm: Uint8Array;
}

/** 解析 16-bit PCM WAV（Qwen-TTS / FakeTts 输出格式）；非 PCM 抛错 */
export function parseWav(bytes: Uint8Array): WavData {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number) =>
    String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
  if (bytes.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let off = 12;
  let fmt: { channels: number; sampleRate: number; bits: number; format: number } | null = null;
  let data: { offset: number; size: number } | null = null;
  while (off + 8 <= bytes.byteLength) {
    const id = tag(off);
    const size = dv.getUint32(off + 4, true);
    if (id === 'fmt ') {
      fmt = {
        format: dv.getUint16(off + 8, true),
        channels: dv.getUint16(off + 10, true),
        sampleRate: dv.getUint32(off + 12, true),
        bits: dv.getUint16(off + 22, true),
      };
    } else if (id === 'data') {
      data = { offset: off + 8, size: Math.min(size, bytes.byteLength - off - 8) };
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('wav missing fmt/data chunk');
  if (fmt.format !== 1) throw new Error(`unsupported wav format: ${fmt.format}`);
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bits,
    pcm: bytes.slice(data.offset, data.offset + data.size),
  };
}

/** 生成指定时长的静音 PCM 字节 */
export function silencePcm(ms: number, sampleRate: number, channels: number, bitsPerSample: number): Uint8Array {
  const frames = Math.max(0, Math.round((ms / 1000) * sampleRate));
  return new Uint8Array(frames * channels * (bitsPerSample / 8));
}

/** 封装 16-bit PCM 单声道/立体声 WAV */
export function encodePcmWav(pcm: Uint8Array, sampleRate: number, channels: number, bitsPerSample = 16): Uint8Array {
  const buf = new Uint8Array(44 + pcm.byteLength);
  const dv = new DataView(buf.buffer);
  const writeTag = (off: number, s: string) => {
    for (let i = 0; i < 4; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  writeTag(0, 'RIFF');
  dv.setUint32(4, 36 + pcm.byteLength, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
  dv.setUint16(32, channels * (bitsPerSample / 8), true);
  dv.setUint16(34, bitsPerSample, true);
  writeTag(36, 'data');
  dv.setUint32(40, pcm.byteLength, true);
  buf.set(pcm, 44);
  return buf;
}

/**
 * 把多段 WAV 音频拼成一整条（段间插入 gapMs 静音）。
 * 拼接前对每段做 RMS 响度归一化（目标 -20 dBFS），使不同 voice 的旁白与角色对白音量一致。
 * 要求各段采样格式一致（同一 TTS 模型输出天然一致）；不一致抛错。
 */
export function concatWavs(wavs: Uint8Array[], gapMs: number): Uint8Array {
  if (wavs.length === 0) throw new Error('concatWavs: empty');
  const parsed = wavs.map(parseWav);
  const first = parsed[0]!;
  for (const p of parsed) {
    if (p.sampleRate !== first.sampleRate || p.channels !== first.channels || p.bitsPerSample !== first.bitsPerSample) {
      throw new Error('concatWavs: mismatched wav formats');
    }
  }
  // 16-bit PCM 才支持归一化（当前 TTS 输出都是 16-bit）
  const canNormalize = first.bitsPerSample === 16;
  const normalized = canNormalize ? parsed.map((p) => ({ ...p, pcm: normalizeRmsPcm(p.pcm, first.channels) })) : parsed;
  const gap = normalized.length > 1 ? silencePcm(gapMs, first.sampleRate, first.channels, first.bitsPerSample) : new Uint8Array(0);
  const total = normalized.reduce((n, p) => n + p.pcm.byteLength, 0) + gap.byteLength * (normalized.length - 1);
  const out = new Uint8Array(total);
  let off = 0;
  normalized.forEach((p, i) => {
    if (i > 0) {
      out.set(gap, off);
      off += gap.byteLength;
    }
    out.set(p.pcm, off);
    off += p.pcm.byteLength;
  });
  return encodePcmWav(out, first.sampleRate, first.channels, first.bitsPerSample);
}

/**
 * 对 16-bit PCM 做 RMS 响度归一化：计算各声道 RMS 后统一缩放到目标电平（-20 dBFS）。
 * 不同 voice 的基础音量不同（角色对白常比旁白安静），归一化后拼接出的旁白段间音量一致。
 * 纯静音段（RMS=0）不缩放，避免除零。
 */
function normalizeRmsPcm(pcm: Uint8Array, _channels: number): Uint8Array {
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = pcm.byteLength / 2; // 16-bit = 2 bytes/sample
  if (samples === 0) return pcm;
  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const s = dv.getInt16(i * 2, true);
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / samples);
  if (rms < 1) return pcm; // 纯静音，不缩放
  // 目标 RMS = -20 dBFS = 10^(-20/20) * 32767 ≈ 3277
  const targetRms = 3277;
  let scale = targetRms / rms;
  // 防削顶：若缩放后峰值超 32767 则限制
  let maxAbs = 0;
  for (let i = 0; i < samples; i++) {
    const s = Math.abs(dv.getInt16(i * 2, true));
    if (s > maxAbs) maxAbs = s;
  }
  if (maxAbs * scale > 32700) scale = 32700 / maxAbs;
  if (Math.abs(scale - 1) < 0.01) return pcm; // 已在目标 ±1% 内，不处理
  const out = new Uint8Array(pcm.byteLength);
  const outDv = new DataView(out.buffer);
  for (let i = 0; i < samples; i++) {
    const s = dv.getInt16(i * 2, true);
    outDv.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(s * scale))), true);
  }
  return out;
}
