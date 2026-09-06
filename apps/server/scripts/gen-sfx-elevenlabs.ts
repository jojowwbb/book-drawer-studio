/**
 * 用 ElevenLabs「文生音效」API 预生成 36 种儿童向情节音效，落到 apps/server/assets/sfx-ai/<type>.wav。
 *
 * 一次性运行（离线预生成，不进产线热路径）：
 *   ELEVENLABS_API_KEY=sk_xxx pnpm --filter @pb/server exec tsx scripts/gen-sfx-elevenlabs.ts
 *
 * 可选参数（env）：
 *   PB_SFX_TYPES="giggle kitten sparkle"   只生成指定类型（默认全部）
 *   PB_SFX_FORCE=1                         覆盖已存在的文件重新生成
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

/** 背景铺底类型（生成时 loop=true 无缝循环，稍长时长），其余为一次性点状音效 */
const BG_TYPES = new Set<SfxCueType>([
  'birds',
  'bee',
  'rain',
  'stream',
  'waves',
  'thunder',
  'fire',
  'clock',
  'snore',
  'frog',
]);

/**
 * 每种音效的英文生成提示词：面向儿童绘本，统一「软、萌、童趣」基调——
 * 幼崽音色、玩具质感、音量轻柔，绝不出现刺耳或惊吓元素。
 * ElevenLabs 对英文 prompt 响应最好，描述具体到音色+质感+氛围。
 */
const PROMPTS: Record<SfxCueType, string> = {
  // 情绪人声
  giggle: 'A tiny cute child giggle, soft and playful, like a little one secretly laughing',
  laugh: 'A sweet innocent child laughing out loud, warm happy and gentle, short burst',
  sniffle: 'A very soft gentle child sniffle, barely crying, tender and comforting, not distressing',
  gasp: 'A small surprised gasp of wonder from a child, soft and delighted, cute',
  cheer: 'A group of happy little children cheering yay together, bright and joyful, gentle',
  yawn: 'A soft sleepy little yawn, cute and drowsy, very gentle',
  snore: 'A gentle rhythmic cute snoring of a child sleeping peacefully, soft and cozy',
  // 可爱动作
  tiptoe: 'Tiny tiptoeing footsteps sneaking on a wooden floor, light quiet and playful, like a small animal creeping',
  scamper: 'Quick little pitter-patter of tiny animal paws running on a soft floor, cute scamper',
  hop: 'A playful cartoonish boing sound of a small creature hopping, soft springy and cute',
  splash: 'A small cute splash in water, like little feet jumping in a puddle, gentle droplets',
  whoosh: 'A soft rounded airy whoosh of something small flying past, gentle and smooth, not sharp',
  // 魔法幻想
  sparkle: 'A delicate magical sparkle chime, like glittering fairy dust twinkling, dreamy music-box brightness, soft',
  poof: 'A soft cute puff sound of magic transformation, like a small cloud of dust appearing with a gentle poof',
  twinkle: 'A gentle wind-chime twinkle of tiny crystal bells, starry and dreamy, very soft and soothing',
  music_box: 'A short sweet music box melody, tinkling celesta notes, cozy nostalgic lullaby feeling, gentle',
  // 小动物
  kitten: 'A tiny baby kitten meowing softly, high-pitched cute and sweet, single short meow',
  puppy: 'A small happy puppy giving two soft little barks, cute yip not scary',
  duckling: 'A baby duckling quacking softly a couple times, tiny squeaky cute quacks',
  frog: 'A small friendly frog croaking gently by a pond, soft cute ribbit sounds',
  owl: 'A gentle owl hooting softly at night, two calm low hoots, soothing not spooky',
  birds: 'Cheerful little songbirds chirping on a sunny morning, gentle pleasant forest ambience',
  bee: 'A soft gentle bee buzzing while flying, warm low hum, friendly and calm',
  // 自然
  rain: 'Soft gentle raindrops falling on leaves, light cozy steady rain ambience, soothing and calm',
  stream: 'A small clear forest brook bubbling gently over smooth pebbles, soft water ambience',
  waves: 'Calm ocean waves gently rolling onto a sandy beach, slow soothing rhythmic ambience',
  thunder: 'Very distant soft rolling thunder, muffled and gentle, far away and not scary at all',
  // 物件
  bell: 'A single ring of a small silver hand bell, bright clear and sweet, gentle chime',
  knock: 'Three soft gentle knocks on a wooden door, small and polite, muted sound',
  door: 'A little wooden door creaking open slowly, soft and gentle, cozy',
  clock: 'The slow steady ticking of a cozy grandfather clock, quiet rhythmic ambience',
  page_turn: 'A storybook page turning with a soft gentle paper rustle, close and cozy',
  balloon: 'A party balloon deflating with a funny squeaky flutter sound, playful and silly, no loud pop',
  fire: 'A cozy small campfire crackling and popping softly, warm gentle ambience',
  // 情节渲染
  drum_roll: 'A short soft toy-drum roll building playful anticipation, small mallets on a little drum, cute not loud',
  fanfare: 'A short triumphant but cute fanfare on toy trumpet and glockenspiel, bright playful celebration, gentle',
};

/** 点状音效时长（秒）；bg 循环音效稍长以便铺底 */
function durationFor(type: SfxCueType): number {
  if (BG_TYPES.has(type)) return 6;
  return type === 'fanfare' || type === 'drum_roll' || type === 'music_box' || type === 'cheer' ? 3 : 1.5;
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
