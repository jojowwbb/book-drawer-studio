import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 内置背景音乐：帕赫贝尔《D 大调卡农》钢琴版。
 * 作曲本身为公版作品；为避免使用任何版权录音，这里用加法合成
 * （谐波叠加 + 指数衰减包络模拟钢琴击弦音色）离线渲染一段 WAV：
 * 左手低音 + 右手经典八分音符琶音（五-三-一-二-六-四-五-三）+ 高音区主旋律。
 */

const SAMPLE_RATE = 44_100;
/** 约 70 BPM，4/4 拍，每小节一个和弦 */
const BEAT_SEC = 60 / 70;
const BAR_SEC = BEAT_SEC * 4;
/** 8 小节一轮（D-A-Bm-F#m-G-D-G-A），共两轮约 55 秒 */
const BARS = 16;

/** D 大调音阶（从 D4=62 起），按级数索引 */
const D_MAJOR = [62, 64, 66, 67, 69, 71, 73];
/** 各小节和弦根音在音阶中的级数（0=D,1=E,2=F#,3=G,4=A,5=B,6=C#） */
const CHORD_ROOTS = [0, 4, 5, 1, 3, 0, 3, 4];
/** 卡农经典八分琶音模式：五-三-一-二-六-四-五-三（相对和弦根音的级数偏移） */
const ARP_DEGREES = [4, 2, 0, 1, 5, 3, 4, 2];
/** 主旋律（二分音符）：取自卡农主题下行音阶句，MIDI 音高 */
const MELODY: number[] = [
  78, 76, 74, 73, 71, 69, 71, 73, // 第一句
  74, 73, 71, 69, 67, 69, 66, 64, // 第二句
  78, 76, 74, 73, 71, 69, 71, 73,
  74, 73, 71, 69, 67, 69, 66, 64,
];

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** 单个钢琴音：6 次谐波 + 指数衰减（高音衰减更快）+ 2ms 起振 */
function addPianoNote(buf: Float64Array, startSec: number, midi: number, gain: number): void {
  const freq = midiToFreq(midi);
  const dur = Math.min(2.6, (buf.length / SAMPLE_RATE) - startSec);
  if (dur <= 0) return;
  const harmonics = [1, 0.42, 0.22, 0.12, 0.06, 0.03];
  // 音越高衰减越快，模拟钢琴高音区短促的音色
  const decay = 1.9 + Math.max(0, (midi - 60) / 12) * 0.9;
  const start = Math.floor(startSec * SAMPLE_RATE);
  const len = Math.floor(dur * SAMPLE_RATE);
  const attack = Math.floor(0.002 * SAMPLE_RATE);
  for (let i = 0; i < len; i += 1) {
    const t = i / SAMPLE_RATE;
    let s = 0;
    for (let h = 0; h < harmonics.length; h += 1) {
      s += harmonics[h]! * Math.sin(2 * Math.PI * freq * (h + 1) * t);
    }
    const env = Math.exp(-decay * t) * Math.min(1, i / attack);
    buf[start + i] = (buf[start + i] ?? 0) + s * env * gain;
  }
}

/** 渲染卡农钢琴 WAV（16-bit PCM 单声道） */
export function synthCanonPianoWav(): Buffer {
  const totalSec = BARS * BAR_SEC + 2.5; // 尾部留 2.5s 让最后一个音自然衰减
  const buf = new Float64Array(Math.ceil(totalSec * SAMPLE_RATE));

  for (let bar = 0; bar < BARS; bar += 1) {
    const root = CHORD_ROOTS[bar % 8]!;
    const barStart = bar * BAR_SEC;
    // 左手：根音 + 五音（每小节两下）
    const bass = D_MAJOR[root]! - 24;
    const bassFifth = D_MAJOR[(root + 4) % 7]! - 24 + ((root + 4 >= 7 ? 12 : 0));
    addPianoNote(buf, barStart, bass, 0.30);
    addPianoNote(buf, barStart + BEAT_SEC * 2, bassFifth, 0.22);
    // 右手八分琶音（中音区）
    for (let e = 0; e < 8; e += 1) {
      const deg = root + ARP_DEGREES[e]!;
      const midi = D_MAJOR[deg % 7]! + 12 * Math.floor(deg / 7);
      addPianoNote(buf, barStart + e * (BEAT_SEC / 2), midi, 0.16);
    }
  }
  // 主旋律：高音区二分音符
  MELODY.forEach((midi, i) => {
    addPianoNote(buf, i * (BEAT_SEC * 2), midi, 0.20);
  });

  // 归一化并转 16-bit PCM
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  const scale = peak > 0 ? 0.85 / peak : 0;
  const pcm = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i += 1) {
    const s = Math.max(-1, Math.min(1, buf[i]! * scale));
    pcm.writeInt16LE(Math.round(s * 32767), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * 取得内置卡农钢琴 WAV 路径：首次调用时渲染并缓存到 assets 根目录，
 * 之后所有绘本导出复用同一文件。
 */
export function ensureCanonPianoWav(cachePath: string): string {
  if (!existsSync(cachePath)) {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, synthCanonPianoWav());
  }
  return cachePath;
}
