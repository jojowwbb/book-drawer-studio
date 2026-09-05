/**
 * 用 ElevenLabs「文生音效」API 预生成 33 种情节音效，落到 apps/server/assets/sfx-ai/<type>.wav。
 *
 * 一次性运行（离线预生成，不进产线热路径）：
 *   ELEVENLABS_API_KEY=sk_xxx pnpm --filter @pb/server exec tsx scripts/gen-sfx-elevenlabs.ts
 *
 * 可选参数（env）：
 *   PB_SFX_TYPES="laugh cat birds"   只生成指定类型（默认全部）
 *   PB_SFX_FORCE=1                   覆盖已存在的文件重新生成
 *
 * 生成产物为 48kHz WAV；bg（背景循环）类型用 loop=true 生成无缝循环。
 * 产线从 assets/sfx-ai 读取（src/export/sfx.ts 唯一素材来源）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SFX_CUE_TYPES, type SfxCueType } from '@pb/renderer';

const API_KEY = process.env.ELEVENLABS_API_KEY ?? '';
if (!API_KEY) {
  console.error('缺少 ELEVENLABS_API_KEY 环境变量');
  process.exit(1);
}

const OUT_DIR = new URL('../assets/sfx-ai/', import.meta.url).pathname;

/** 默认按背景铺底的类型（生成时 loop=true，其余为一次性点状音效） */
const BG_TYPES = new Set<SfxCueType>(['birds', 'waves', 'fire', 'water', 'frog', 'clock', 'snore', 'thunder']);

/**
 * 每种音效的英文生成提示词：面向儿童绘本场景，柔和、干净、无突兀。
 * 描述尽量具体（音色+质感+氛围），ElevenLabs 对英文 prompt 响应最好。
 */
const PROMPTS: Record<SfxCueType, string> = {
  laugh: 'A warm, gentle child-like laughter, happy and soft, single burst',
  cry: 'A soft, gentle child crying briefly, tender and not distressing',
  footsteps: 'Light soft footsteps walking on a wooden floor, quiet and steady',
  door: 'A wooden door gently creaking open, soft and slow',
  knock: 'Three gentle knocks on a wooden door with a knuckle',
  bell: 'A small silver hand bell ringing once, bright and clear, gentle chime',
  thunder: 'Distant soft rolling thunder rumble, gentle storm ambience, not scary',
  birds: 'Cheerful songbirds chirping in a calm forest on a sunny morning, gentle ambience',
  water: 'A small gentle stream of water flowing softly over smooth stones',
  giggle: 'A light playful little giggle, cute and soft',
  applause: 'A round of warm friendly applause from a small crowd of children',
  cheer: 'A joyful group cheer, happy cheering voices celebrating, gentle',
  gasp: 'A single soft surprised gasp of wonder, gentle',
  sigh: 'A calm gentle contented sigh, soft and relaxed',
  magic: 'A whimsical magical sparkle chime, fairy dust twinkle, dreamy and soft',
  whoosh: 'A soft airy whoosh of something quickly passing by, gentle wind swoosh',
  heartbeat: 'A slow calm steady heartbeat thump, soft and deep',
  yawn: 'A soft sleepy gentle yawn, tired and relaxed',
  snore: 'A gentle rhythmic soft snoring of someone sleeping peacefully',
  cat: 'A single soft friendly cat meow, gentle and cute',
  dog: 'A small friendly dog bark, gentle and happy, single short bark',
  rooster: 'A cheerful rooster crowing on a farm in the morning',
  duck: 'A couple of soft friendly duck quacks, gentle',
  frog: 'Gentle frogs croaking by a calm pond at night, soft ambience',
  cow: 'A single low gentle cow moo from a peaceful farm',
  waves: 'Calm ocean waves gently rolling onto a sandy beach, soothing ambience',
  fire: 'A cozy campfire crackling and popping softly, warm gentle ambience',
  clock: 'A soft steady ticking of a grandfather clock, quiet rhythmic ambience',
  phone: 'An old-fashioned telephone ringing softly, gentle bell ringtone',
  balloon: 'A single bright party balloon popping, playful',
  page_turn: 'A paper book page turning with a soft gentle rustle',
  drum_roll: 'A short soft snare drum roll, playful, building anticipation',
  fanfare: 'A short triumphant cheerful brass fanfare, bright and celebratory',
};

/** 点状音效时长（秒）；bg 循环音效稍长以便铺底 */
function durationFor(type: SfxCueType): number {
  if (BG_TYPES.has(type)) return 6;
  return type === 'fanfare' || type === 'drum_roll' || type === 'applause' || type === 'cheer' ? 3 : 1.5;
}

async function generateOne(type: SfxCueType): Promise<Buffer> {
  const res = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
    method: 'POST',
    headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: PROMPTS[type],
      model_id: 'eleven_text_to_sound_v2',
      duration_seconds: durationFor(type),
      prompt_influence: 0.4,
      loop: BG_TYPES.has(type),
    }),
  });
  if (!res.ok) {
    throw new Error(`${type}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer()); // MP3
}

/** MP3 → 单声道 22.05kHz WAV（与内置录音规格一致），alimiter 防削顶 */
function mp3ToWav(mp3: Buffer, type: SfxCueType): Buffer {
  const tmpMp3 = join(tmpdir(), `sfx-${type}.mp3`);
  const tmpWav = join(tmpdir(), `sfx-${type}.wav`);
  writeFileSync(tmpMp3, mp3);
  const ff = spawnSync('ffmpeg', [
    '-y', '-v', 'error', '-i', tmpMp3,
    '-ac', '1', '-ar', '22050',
    '-af', 'alimiter=limit=0.7',
    tmpWav,
  ]);
  rmSync(tmpMp3, { force: true });
  if (ff.status !== 0) {
    throw new Error(`${type}: ffmpeg 转码失败 ${ff.stderr.toString().slice(-300)}`);
  }
  const wav = readFileSync(tmpWav);
  rmSync(tmpWav, { force: true });
  return wav;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const selected = (process.env.PB_SFX_TYPES?.trim()
    ? process.env.PB_SFX_TYPES.trim().split(/\s+/)
    : [...SFX_CUE_TYPES]) as SfxCueType[];
  const force = process.env.PB_SFX_FORCE === '1';
  let ok = 0;
  let skip = 0;
  const failed: string[] = [];

  for (const type of selected) {
    const out = join(OUT_DIR, `${type}.wav`);
    if (!force && existsSync(out)) {
      skip += 1;
      continue;
    }
    try {
      const mp3 = await generateOne(type);
      const wav = mp3ToWav(mp3, type);
      writeFileSync(out, wav);
      ok += 1;
      console.log(`✓ ${type} (${(wav.length / 1024).toFixed(0)} KB)`);
    } catch (err) {
      failed.push(type);
      console.error(`✗ ${type}: ${(err as Error).message}`);
    }
  }
  console.log(`\n完成：新生成 ${ok}，跳过 ${skip}，失败 ${failed.length}${failed.length ? ` (${failed.join(', ')})` : ''}`);
  if (failed.length) process.exit(1);
}

void main();
