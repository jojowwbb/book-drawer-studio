import { existsSync } from 'node:fs';
import type { SfxCueType } from '@pb/renderer';

/**
 * 情节音效库：由文案生成阶段分析的 sfx cues（笑声/脚步/雷声等）驱动，
 * 导出时按 cue 的 at 时刻用 adelay 定位混入旁白轨。
 *
 * 素材唯一来源：apps/server/assets/sfx-ai/<type>.wav——ElevenLabs 文生音效 API
 * 预生成（见 scripts/gen-sfx-elevenlabs.ts，单声道 22.05kHz WAV）。
 * 算法拟音与 Pixabay 内置录音均已废弃（质量不达标，用户确认移除）。
 *
 * 与 pickSfx（环境声 rain/wind，整页铺底的 lavfi 噪声）互补：这里是「点状」动作声。
 */

/** AI 音效目录（相对本文件：src/export → apps/server/assets/sfx-ai） */
const SFX_DIR = new URL('../../assets/sfx-ai/', import.meta.url).pathname;

/** 一条音效 cue 的渲染结果：WAV 文件路径 + 相对建议音量 */
export interface SfxAsset {
  path: string;
  volume: number;
}

/** 各音效类型的建议混音音量（相对旁白；旁白 RMS 已归一到 -20dBFS） */
const TYPE_VOLUME: Record<SfxCueType, number> = {
  giggle: 0.45,
  laugh: 0.5,
  sniffle: 0.4,
  gasp: 0.45,
  cheer: 0.5,
  yawn: 0.4,
  snore: 0.4,
  tiptoe: 0.45,
  scamper: 0.45,
  hop: 0.45,
  splash: 0.5,
  whoosh: 0.45,
  sparkle: 0.45,
  poof: 0.45,
  twinkle: 0.4,
  music_box: 0.4,
  kitten: 0.45,
  puppy: 0.5,
  duckling: 0.5,
  frog: 0.45,
  owl: 0.45,
  birds: 0.4,
  bee: 0.35,
  rain: 0.4,
  stream: 0.4,
  waves: 0.4,
  thunder: 0.55,
  bell: 0.4,
  knock: 0.55,
  door: 0.5,
  clock: 0.4,
  page_turn: 0.45,
  balloon: 0.45,
  fire: 0.35,
  drum_roll: 0.5,
  fanfare: 0.5,
};

/**
 * 取得某音效类型的 WAV 路径（assets/sfx-ai/<type>.wav）。
 * 返回 null 表示素材缺失（该 cue 跳过混音，不阻塞导出）。
 */
export function ensureSfxWav(type: SfxCueType): SfxAsset | null {
  const path = `${SFX_DIR}${type}.wav`;
  return existsSync(path) ? { path, volume: TYPE_VOLUME[type] } : null;
}
