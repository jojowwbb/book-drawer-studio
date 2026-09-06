import { mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SfxCueSpec } from '@pb/renderer';
import { ensureSfxWav } from './sfx';
import { spawnFfmpeg } from './ffmpeg';

/**
 * 片段拼接公共核：把「每段归一化（旁白混音/静音补齐/音效）→ xfade 转场或 concat 硬切 → BGM 混入」
 * 从绘本导出器抽出，供多条产线（绘本 ConcatExporter、故事视频 ProjectExporter）复用。
 * 只依赖文件路径与时长，不依赖任何产线的记录/规格类型。
 */

export interface JoinDeps {
  ffmpegBin?: string;
  /** 重编码拼接时的目标帧率 */
  fps?: number;
  /** 幕间转场时长（ms）；0 关闭转场回到硬切拼接 */
  transitionMs?: number;
  /** xfade 转场类型（翻页感，如 slideleft/coverleft；缺省 DEFAULT_TRANSITION_TYPE，'fade' 为交叉溶解） */
  transition?: TransitionType;
  /** BGM 相对音量（旁白保持原音量），默认 0.12 */
  bgmVolume?: number;
  /** 音效层开关；默认开启 */
  sfx?: boolean;
  /** 音频流探测（默认 ffprobe）；测试可注入桩 */
  probeHasAudio?: (path: string) => Promise<boolean>;
}

export interface JoinPart {
  clipPath: string;
  clipMs: number;
  narrationPath?: string;
  /** 旁白音频时长（含起播延迟与收尾留白），用于判断是否需要延长该段 */
  narrationMs?: number;
  /** 旁白纯语音时长（不含延迟/留白），用于把 sfx cue 的 at 对齐到实际发声时刻 */
  narrationVoiceMs?: number;
  clipHasAudio: boolean;
  /** 环境氛围类型（rain/snow/clouds_drift…），派生整段铺底的环境音效 */
  ambient?: string[];
  /** 情节音效 cues（笑声/脚步等），at 为旁白文稿位置比例，导出时对齐到实际发声时刻混入 */
  cues?: SfxCueSpec[];
}

export interface JoinResult {
  totalMs: number;
  sizeBytes: number;
}

/** 幕间转场默认时长：吃掉旁白 800ms 收尾留白，总时长几乎不增加 */
export const DEFAULT_TRANSITION_MS = 600;

/**
 * xfade 转场类型（绘本翻页感优先）：
 * - slideleft：旧页向左滑出、新页从右滑入，最接近翻书方向（默认）
 * - coverleft：新页从左盖入（像翻页覆过）
 * - wipeleft：自左向右擦除揭示新页
 * - fade：交叉溶解（旧行为）
 */
export const TRANSITION_TYPES = ['slideleft', 'coverleft', 'wipeleft', 'fade'] as const;
export type TransitionType = (typeof TRANSITION_TYPES)[number];
export const DEFAULT_TRANSITION_TYPE: TransitionType = 'slideleft';

function concatEscape(path: string): string {
  return path.replace(/'/g, "'\\''");
}

export const AUDIO_SAMPLE_RATE = 44_100;
/** 旁白起播延迟：片段开始后 800ms 再出声，避免画面未稳定就开口 */
export const NARRATION_LEAD_MS = 800;
/** 旁白收尾留白：语音结束后再保留 800ms 画面，避免话音刚落就切幕 */
export const NARRATION_TAIL_MS = 800;

/**
 * 按段内氛围类型选一条环境音效的 lavfi 噪声源（每段最多一种，取首个可配音效的类型）：
 * rain→粉噪经低通近似沙沙雨声；snow/clouds_drift→布朗噪声+低通+慢速颤音近似风声。
 * 其余（星点/流萤/光束）安静，不配音效。返回 [源描述, 音量]。
 */
export function pickSfx(ambientTypes: string[], durationSec: number): [string, number] | null {
  const dur = durationSec.toFixed(3);
  for (const t of ambientTypes) {
    if (t === 'rain') {
      return [`anoisesrc=color=pink:amplitude=0.5:duration=${dur},lowpass=f=1200`, 0.06];
    }
    if (t === 'snow' || t === 'clouds_drift') {
      return [`anoisesrc=color=brown:amplitude=0.6:duration=${dur},lowpass=f=500,tremolo=f=0.3:d=0.6`, 0.05];
    }
  }
  return null;
}

/** 一条已解析的音效 cue：WAV 路径 + 音量 + 在本段的出现时刻（ms） */
export interface ResolvedCue {
  path: string;
  volume: number;
  atMs: number;
}

/**
 * 把段上的 sfx cues 解析成可混音的音效（素材取 assets/sfx-ai，缺失即跳过该 cue）。
 * cue 的 at 是「该声音对应词语在旁白文稿中的位置比例」：有旁白时换算成实际发声时刻
 * （旁白延迟 NARRATION_LEAD_MS 起播，故 atMs = LEAD + at×语音时长）；
 * 无旁白时退化为占整段时长的比例。末尾留 200ms 余量，避免 cue 贴到切幕点。
 */
export function resolveCues(
  cues: SfxCueSpec[],
  pageMs: number,
  narrationVoiceMs?: number,
): ResolvedCue[] {
  const out: ResolvedCue[] = [];
  const last = Math.max(0, pageMs - 200);
  for (const cue of cues) {
    const asset = ensureSfxWav(cue.type);
    if (!asset) continue;
    const raw =
      narrationVoiceMs && narrationVoiceMs > 0
        ? NARRATION_LEAD_MS + cue.at * narrationVoiceMs
        : cue.at * pageMs;
    out.push({ path: asset.path, volume: asset.volume, atMs: Math.round(Math.min(raw, last)) });
  }
  return out;
}

/** 音效 cue 的公共混音滤镜：立体声化 + 定音量 + adelay 定位到 cue 时刻（每段单次播放） */
function cueFilter(inputIdx: number, cue: ResolvedCue, label: string): string {
  const d = `${cue.atMs}|${cue.atMs}`;
  return (
    `[${inputIdx}:a]aformat=sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo,` +
    `volume=${cue.volume},adelay=${d}[${label}]`
  );
}

/**
 * 把旁白（以及可选的环境音效轨）混入片段：音频统一 AAC 44.1kHz 立体声；旁白延迟 800ms 起播，
 * anullsrc 静音轨补齐长度。若旁白（含起播延迟与 800ms 收尾留白）比片段长，
 * 用 tpad 冻结尾帧把该段延长到旁白讲完，避免语音没说完就切下一幕；否则输出锁定片段原时长。
 * sfx 传入 [lavfi 噪声源, 音量] 时，音效与旁白同轨混入（首尾淡入淡出）；
 * cues 为情节音效（笑声/脚步等），各自 adelay 定位到段内时刻后一并 amix。
 */
async function mixNarration(
  deps: JoinDeps,
  clipPath: string,
  narrationPath: string,
  outPath: string,
  clipMs: number,
  outMs: number,
  clipHasAudio: boolean,
  sfx?: [string, number],
  cues: ResolvedCue[] = [],
): Promise<void> {
  mkdirSync(dirname(outPath), { recursive: true });
  const outSec = outMs / 1000;
  const args = [
    '-y', '-v', 'error',
    '-i', clipPath,
    '-i', narrationPath,
    '-f', 'lavfi', '-t', String(outSec),
    '-i', `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_SAMPLE_RATE}`,
  ];
  const filters: string[] = [
    `[1:a]adelay=${NARRATION_LEAD_MS}|${NARRATION_LEAD_MS},aformat=sample_rates=44100:channel_layouts=stereo[narr]`,
  ];
  const mixInputs: string[] = ['[narr]', '[2:a]'];
  let inputCount = 3;
  if (sfx) {
    args.push('-f', 'lavfi', '-i', sfx[0]);
    const fade = Math.min(0.4, outSec / 4);
    const fadeOut = Math.max(0, outSec - fade).toFixed(3);
    filters.push(
      `[${inputCount}:a]aformat=sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo,` +
        `volume=${sfx[1]},afade=t=in:d=${fade},afade=t=out:st=${fadeOut}:d=${fade}[sfx]`,
    );
    mixInputs.push('[sfx]');
    inputCount += 1;
  }
  cues.forEach((cue, i) => {
    args.push('-i', cue.path);
    filters.push(cueFilter(inputCount, cue, `cue${i}`));
    mixInputs.push(`[cue${i}]`);
    inputCount += 1;
  });
  if (clipHasAudio) {
    filters.push(`[0:a]aformat=sample_rates=44100:channel_layouts=stereo[va]`);
    mixInputs.unshift('[va]');
  }
  filters.push(
    `${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=longest:normalize=0[aout]`,
  );
  const extendSec = (outMs - clipMs) / 1000;
  // 延长需要重编码视频流（tpad 补帧）；不延长保持流拷贝
  const videoPre = extendSec > 0.05 ? `[0:v]tpad=stop_mode=clone:stop_duration=${extendSec.toFixed(3)}[vout];` : '';
  const videoMap = extendSec > 0.05 ? ['-map', '[vout]'] : ['-map', '0:v'];
  const videoCodec =
    extendSec > 0.05
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']
      : ['-c:v', 'copy'];
  await spawnFfmpeg(deps.ffmpegBin ?? 'ffmpeg', [
    ...args,
    '-filter_complex',
    `${videoPre}${filters.join(';')}`,
    ...videoMap, '-map', '[aout]',
    ...videoCodec, '-c:a', 'aac', '-ar', String(AUDIO_SAMPLE_RATE), '-ac', '2',
    '-t', String(outSec),
    outPath,
  ]);
}

/** 给无声片段补一条定长静音轨（视频流拷贝），使各段流结构一致可拼接；带音效/情节 cue 时一并混入。 */
async function addSilence(
  deps: JoinDeps,
  clipPath: string,
  outPath: string,
  durationSec: number,
  sfx?: [string, number],
  cues: ResolvedCue[] = [],
): Promise<void> {
  mkdirSync(dirname(outPath), { recursive: true });
  if (!sfx && cues.length === 0) {
    await spawnFfmpeg(deps.ffmpegBin ?? 'ffmpeg', [
      '-y', '-v', 'error',
      '-i', clipPath,
      '-f', 'lavfi', '-t', String(durationSec),
      '-i', `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_SAMPLE_RATE}`,
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'copy', '-c:a', 'aac', '-ar', String(AUDIO_SAMPLE_RATE), '-ac', '2',
      '-t', String(durationSec),
      outPath,
    ]);
    return;
  }
  const args = [
    '-y', '-v', 'error',
    '-i', clipPath,
    '-f', 'lavfi', '-t', String(durationSec),
    '-i', `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_SAMPLE_RATE}`,
  ];
  const filters: string[] = [];
  const mixInputs: string[] = ['[1:a]'];
  let inputCount = 2;
  if (sfx) {
    const fade = Math.min(0.4, durationSec / 4);
    const fadeOut = Math.max(0, durationSec - fade).toFixed(3);
    args.push('-f', 'lavfi', '-i', sfx[0]);
    filters.push(
      `[${inputCount}:a]aformat=sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo,` +
        `volume=${sfx[1]},afade=t=in:d=${fade},afade=t=out:st=${fadeOut}:d=${fade}[sfx]`,
    );
    mixInputs.push('[sfx]');
    inputCount += 1;
  }
  cues.forEach((cue, i) => {
    args.push('-i', cue.path);
    filters.push(cueFilter(inputCount, cue, `cue${i}`));
    mixInputs.push(`[cue${i}]`);
    inputCount += 1;
  });
  filters.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:normalize=0[aout]`);
  await spawnFfmpeg(deps.ffmpegBin ?? 'ffmpeg', [
    ...args,
    '-filter_complex', filters.join(';'),
    '-map', '0:v', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', 'aac', '-ar', String(AUDIO_SAMPLE_RATE), '-ac', '2',
    '-t', String(durationSec),
    outPath,
  ]);
}

/**
 * 把若干定长片段（均已带音轨）用转场串成一条时间线：
 * 视频 xfade（转场类型可配，默认 slideleft 翻页感）逐段叠加，音频 acrossfade 同步重叠，
 * 总时长 = 各段之和 - (段数-1)×转场时长。
 */
async function xfadeJoin(
  deps: JoinDeps,
  parts: { path: string; durationMs: number }[],
  width: number,
  height: number,
  transitionMs: number,
  transition: TransitionType,
  hasAudio: boolean,
  outPath: string,
): Promise<void> {
  const t = transitionMs / 1000;
  const fps = deps.fps ?? 30;
  const args = ['-y', '-v', 'error'];
  for (const p of parts) args.push('-i', p.path);

  const norm: string[] = [];
  parts.forEach((_, i) => {
    norm.push(
      `[${i}:v]fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}]`,
    );
    if (hasAudio) {
      norm.push(
        `[${i}:a]aformat=sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo[a${i}]`,
      );
    }
  });

  const chain: string[] = [];
  let acc = 0;
  parts.forEach((p, i) => {
    if (i === 0) {
      acc = p.durationMs / 1000;
      return;
    }
    const vIn = i === 1 ? '[v0]' : `[x${i - 1}]`;
    const offset = Math.max(0, acc - t);
    chain.push(`${vIn}[v${i}]xfade=transition=${transition}:duration=${t}:offset=${offset.toFixed(3)}[x${i}]`);
    if (hasAudio) {
      const aIn = i === 1 ? '[a0]' : `[y${i - 1}]`;
      chain.push(`${aIn}[a${i}]acrossfade=d=${t}:c1=tri:c2=tri[y${i}]`);
    }
    acc = acc + p.durationMs / 1000 - t;
  });

  const last = parts.length - 1;
  args.push('-filter_complex', [...norm, ...chain].join(';'), '-map', `[x${last}]`);
  if (hasAudio) {
    args.push('-map', `[y${last}]`, '-c:a', 'aac', '-ar', String(AUDIO_SAMPLE_RATE), '-ac', '2');
  }
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-movflags', '+faststart',
    outPath,
  );
  await spawnFfmpeg(deps.ffmpegBin ?? 'ffmpeg', args);
}

/**
 * 把背景音乐低音量混入已拼好的成片：BGM 循环铺满全片、按 volume 压低、
 * 片头 1.5s 淡入、片尾 2.5s 淡出。视频流直接拷贝（只改音轨，无画质损失）。
 * 成片无音轨时（全片静音）把 BGM 作为唯一音轨挂上。
 */
async function mixBgm(
  deps: JoinDeps,
  inPath: string,
  bgmPath: string,
  totalSec: number,
  hasAudio: boolean,
  outPath: string,
): Promise<void> {
  const vol = deps.bgmVolume ?? 0.12;
  const fadeOutStart = Math.max(0, totalSec - 2.5).toFixed(3);
  const bgmFilter =
    `[1:a]aformat=sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo,` +
    `volume=${vol},afade=t=in:d=1.5,afade=t=out:st=${fadeOutStart}:d=2.5[bgm]`;
  const args = [
    '-y', '-v', 'error',
    '-i', inPath,
    '-stream_loop', '-1', '-t', String(totalSec), '-i', bgmPath,
  ];
  if (hasAudio) {
    args.push(
      '-filter_complex',
      `${bgmFilter};[0:a]aformat=sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo[va];[va][bgm]amix=inputs=2:duration=first:normalize=0[aout]`,
      '-map', '0:v', '-map', '[aout]',
    );
  } else {
    args.push('-filter_complex', bgmFilter, '-map', '0:v', '-map', '[bgm]');
  }
  args.push(
    '-c:v', 'copy', '-c:a', 'aac', '-ar', String(AUDIO_SAMPLE_RATE), '-ac', '2',
    '-t', String(totalSec),
    '-movflags', '+faststart',
    outPath,
  );
  await spawnFfmpeg(deps.ffmpegBin ?? 'ffmpeg', args);
}

/**
 * 拼接出片主流程：逐段混音归一（旁白/静音补齐/环境声/情节 cue）→ xfade 转场或 concat 硬切 →
 * BGM 混入（bgmPath 传入时）。outPath 为最终成片；中间产物写在 outPath 同目录（.part-<tag>-<id>.mp4）。
 * tag 用于区分同目录不同产物的临时文件（如语言码）。
 */
export async function joinClips(
  deps: JoinDeps,
  parts: JoinPart[],
  size: { width: number; height: number },
  outPath: string,
  opts: { tag: string; bgmPath?: string },
): Promise<JoinResult> {
  const tmpDir = dirname(outPath);
  const sfxOn = deps.sfx !== false;
  // 音轨存在性：旁白、片段自带音、或（音效层开启时的）情节 cue——只有 bg cue 的无声页也要混出音轨
  const anyAudio = parts.some((p) => p.narrationPath || p.clipHasAudio || (sfxOn && p.cues?.length));
  const transitionMs = deps.transitionMs ?? DEFAULT_TRANSITION_MS;
  const transition = deps.transition ?? DEFAULT_TRANSITION_TYPE;
  const useXfade = transitionMs > 0 && parts.length >= 2;

  // 每段归一化后的成片时长（旁白超时延长）；xfade 模式下逐段重叠扣减
  const partOut = parts.map((p) => Math.max(p.clipMs, p.narrationMs ?? 0));
  let totalMs = partOut.reduce((a, b) => a + b, 0);
  if (useXfade) totalMs -= (parts.length - 1) * transitionMs;
  const partFiles: { path: string; durationMs: number }[] = [];
  const listLines: string[] = [];
  for (const [i, part] of parts.entries()) {
    let path = part.clipPath;
    if (anyAudio) {
      const sfx =
        sfxOn && part.ambient ? pickSfx(part.ambient, partOut[i]! / 1000) : null;
      const cues =
        sfxOn && part.cues
          ? resolveCues(part.cues, partOut[i]!, part.narrationVoiceMs)
          : [];
      if (part.narrationPath) {
        path = `${tmpDir}/.part-${opts.tag}-${i}.mp4`;
        await mixNarration(deps, part.clipPath, part.narrationPath, path, part.clipMs, partOut[i]!, part.clipHasAudio, sfx ?? undefined, cues);
      } else if (!part.clipHasAudio) {
        path = `${tmpDir}/.part-${opts.tag}-${i}.mp4`;
        await addSilence(deps, part.clipPath, path, partOut[i]! / 1000, sfx ?? undefined, cues);
      }
    }
    partFiles.push({ path, durationMs: partOut[i]! });
    listLines.push(`file '${concatEscape(path)}'`);
  }

  mkdirSync(tmpDir, { recursive: true });
  if (useXfade) {
    // 幕间转场（默认翻页感 slideleft）：xfade/acrossfade 时间线拼接（全片重编码，规格统一到给定尺寸）
    await xfadeJoin(deps, partFiles, size.width, size.height, transitionMs, transition, anyAudio, outPath);
  } else {
    const listPath = `${tmpDir}/.concat-${opts.tag}.txt`;
    writeFileSync(listPath, `${listLines.join('\n')}\n`);
    if (!anyAudio) {
      await spawnFfmpeg(deps.ffmpegBin ?? 'ffmpeg', [
        '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
        '-c', 'copy', '-movflags', '+faststart', outPath,
      ]);
    } else {
      // 含音轨时不能整段流拷贝（不同来源片段参数不一致）：
      // 重编码统一到给定尺寸，音频保持 AAC 44.1k 立体声
      await spawnFfmpeg(deps.ffmpegBin ?? 'ffmpeg', [
        '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listPath,
        '-vf',
        `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2,fps=${deps.fps ?? 30},format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-c:a', 'aac', '-ar', String(AUDIO_SAMPLE_RATE), '-ac', '2',
        '-movflags', '+faststart', outPath,
      ]);
    }
  }

  // 背景音乐：低音量混入（视频流拷贝，仅重编音轨）
  if (opts.bgmPath) {
    const tmpPath = `${tmpDir}/.bgm-${opts.tag}.mp4`;
    await mixBgm(deps, outPath, opts.bgmPath, totalMs / 1000, anyAudio, tmpPath);
    renameSync(tmpPath, outPath);
  }

  return { totalMs, sizeBytes: statSync(outPath).size };
}
