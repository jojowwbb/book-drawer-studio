import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BookSpecSchema, type BookSpec } from '@pb/renderer';
import { AssetStore } from '../asset-store';
import { clipPathFor } from './clip-source';
import { ConcatExporter } from './concat-exporter';

beforeAll(() => {
  const r = spawnSync('ffmpeg', ['-version']);
  if (r.status !== 0) throw new Error('ffmpeg is required for concat tests');
});

let dir: string;
let store: AssetStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pb-concat-'));
  store = new AssetStore(dir);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function genClip(path: string, seconds: number, color: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
    '-i', `color=c=${color}:s=64x36:d=${seconds}:r=30`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path]);
  if (r.status !== 0) throw new Error('gen clip failed');
}

function genWav(path: string, seconds: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
    '-i', `sine=frequency=440:duration=${seconds}`, '-ar', '24000', '-ac', '1', path]);
  if (r.status !== 0) throw new Error('gen wav failed');
}

function probeAudioStreams(path: string): number {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a',
    '-show_entries', 'stream=index', '-of', 'csv=p=0', path]);
  return r.stdout.toString('utf8').trim().split('\n').filter(Boolean).length;
}

describe('ConcatExporter', () => {
  it(
    'concatenates page clips in spec order',
    async () => {
      const pages = ['p1', 'p2'].map((page_id) => ({
        page_id,
        duration_ms: 3000,
        camera: { type: 'ken_burns_in' as const, intensity: 0.5 },
        background: { src: `/assets/books/b1/pages/${page_id}/background.png` },
      }));
      store.writeBookSpec('b1', 'zh', BookSpecSchema.parse({ id: 'b1-zh', pages }) as BookSpec);
      genClip(clipPathFor(store, 'b1', 'p1'), 2, 'red');
      genClip(clipPathFor(store, 'b1', 'p2'), 3, 'blue');
      store.writePageAssets('b1', 'p1', {
        page_id: 'p1', seed: 1, image_url: '/x', background_url: '/y', subject_urls: [],
        clip_url: '/assets/books/b1/pages/p1/clip.mp4', clip_duration_ms: 2000,
      });
      store.writePageAssets('b1', 'p2', {
        page_id: 'p2', seed: 2, image_url: '/x', background_url: '/y', subject_urls: [],
        clip_url: '/assets/books/b1/pages/p2/clip.mp4', clip_duration_ms: 3000,
      });

      const artifact = await new ConcatExporter({ assets: store, bgmPath: null }).exportBook('b1', 'zh');
      expect(artifact.url).toBe('/assets/books/b1/exports/zh.mp4');
      expect(artifact.duration_ms).toBe(4400); // 2000 + 3000 - 600 交叉溶解重叠

      const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
        '-of', 'csv=p=0', join(dir, 'books/b1/exports/zh.mp4')]);
      const duration = Number(probe.stdout.toString('utf8').trim());
      expect(duration).toBeGreaterThan(3.9);
      expect(duration).toBeLessThan(4.9);
    },
    60_000,
  );

  it(
    'mixes per-page narration into the exported video',
    async () => {
      const pages = ['p1', 'p2'].map((page_id) => ({
        page_id,
        duration_ms: 3000,
        camera: { type: 'ken_burns_in' as const, intensity: 0.5 },
        background: { src: `/assets/books/b2/pages/${page_id}/background.png` },
      }));
      store.writeBookSpec('b2', 'zh', BookSpecSchema.parse({ id: 'b2-zh', pages }) as BookSpec);
      genClip(clipPathFor(store, 'b2', 'p1'), 2, 'red');
      genClip(clipPathFor(store, 'b2', 'p2'), 2, 'blue');
      genWav(store.rootPath('books', 'b2', 'pages', 'p1', 'narration.wav'), 1.2);
      store.writePageAssets('b2', 'p1', {
        page_id: 'p1', seed: 1, image_url: '/x', background_url: '/y', subject_urls: [],
        clip_url: '/assets/books/b2/pages/p1/clip.mp4', clip_duration_ms: 2000,
        narration_url: '/assets/books/b2/pages/p1/narration.wav', narration_duration_ms: 1200,
      });
      store.writePageAssets('b2', 'p2', {
        page_id: 'p2', seed: 2, image_url: '/x', background_url: '/y', subject_urls: [],
        clip_url: '/assets/books/b2/pages/p2/clip.mp4', clip_duration_ms: 2000,
      });

      const artifact = await new ConcatExporter({ assets: store }).exportBook('b2', 'zh');
      // p1 旁白占 800 + 1200 + 800 = 2800ms > 片段 2000ms → 该页延长到 2800；再扣 600ms 转场重叠
      expect(artifact.duration_ms).toBe(4200);

      const out = join(dir, 'books/b2/exports/zh.mp4');
      expect(probeAudioStreams(out)).toBe(1);
      const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
        '-of', 'csv=p=0', out]);
      const duration = Number(probe.stdout.toString('utf8').trim());
      expect(duration).toBeGreaterThan(3.7);
      expect(duration).toBeLessThan(4.7);
    },
    60_000,
  );

  it(
    'extends the page with a frozen last frame when narration outlasts the clip',
    async () => {
      const pages = ['p1', 'p2'].map((page_id) => ({
        page_id,
        duration_ms: 3000,
        camera: { type: 'ken_burns_in' as const, intensity: 0.5 },
        background: { src: `/assets/books/b3/pages/${page_id}/background.png` },
      }));
      store.writeBookSpec('b3', 'zh', BookSpecSchema.parse({ id: 'b3-zh', pages }) as BookSpec);
      // p1 片段只有 2s，但旁白 4.5s（800ms 起播 + 4500 + 800ms 收尾 = 6100ms）→ 该页延长到 6.1s
      genClip(clipPathFor(store, 'b3', 'p1'), 2, 'red');
      genClip(clipPathFor(store, 'b3', 'p2'), 2, 'blue');
      genWav(store.rootPath('books', 'b3', 'pages', 'p1', 'narration.wav'), 4.5);
      store.writePageAssets('b3', 'p1', {
        page_id: 'p1', seed: 1, image_url: '/x', background_url: '/y', subject_urls: [],
        clip_url: '/assets/books/b3/pages/p1/clip.mp4', clip_duration_ms: 2000,
        narration_url: '/assets/books/b3/pages/p1/narration.wav', narration_duration_ms: 4500,
      });
      store.writePageAssets('b3', 'p2', {
        page_id: 'p2', seed: 2, image_url: '/x', background_url: '/y', subject_urls: [],
        clip_url: '/assets/books/b3/pages/p2/clip.mp4', clip_duration_ms: 2000,
      });

      const artifact = await new ConcatExporter({ assets: store }).exportBook('b3', 'zh');
      expect(artifact.duration_ms).toBe(7500); // 6100 + 2000 - 600 转场重叠

      const out = join(dir, 'books/b3/exports/zh.mp4');
      expect(probeAudioStreams(out)).toBe(1);
      const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
        '-of', 'csv=p=0', out]);
      const duration = Number(probe.stdout.toString('utf8').trim());
      // 旁白完整播完不被切断：总时长 >= 6.1 + 2 - 0.6 - 编码余量
      expect(duration).toBeGreaterThan(7.2);
      expect(duration).toBeLessThan(8.0);
    },
    60_000,
  );

  it(
    'falls back to hard-cut concat when transitionMs is 0',
    async () => {
      const pages = ['p1', 'p2'].map((page_id) => ({
        page_id,
        duration_ms: 2000,
        camera: { type: 'ken_burns_in' as const, intensity: 0.5 },
        background: { src: `/assets/books/b4/pages/${page_id}/background.png` },
      }));
      store.writeBookSpec('b4', 'zh', BookSpecSchema.parse({ id: 'b4-zh', pages }) as BookSpec);
      genClip(clipPathFor(store, 'b4', 'p1'), 2, 'green');
      genClip(clipPathFor(store, 'b4', 'p2'), 2, 'yellow');
      store.writePageAssets('b4', 'p1', {
        page_id: 'p1', seed: 1, image_url: '/x', background_url: '/y', subject_urls: [],
        clip_url: '/assets/books/b4/pages/p1/clip.mp4', clip_duration_ms: 2000,
      });
      store.writePageAssets('b4', 'p2', {
        page_id: 'p2', seed: 2, image_url: '/x', background_url: '/y', subject_urls: [],
        clip_url: '/assets/books/b4/pages/p2/clip.mp4', clip_duration_ms: 2000,
      });

      const artifact = await new ConcatExporter({ assets: store, transitionMs: 0 }).exportBook('b4', 'zh');
      expect(artifact.duration_ms).toBe(4000); // 无转场：硬切直加
    },
    60_000,
  );

  it(
    'mixes the built-in canon piano bgm under the narration',
    async () => {
      const pages = ['p1', 'p2'].map((page_id) => ({
        page_id,
        duration_ms: 2000,
        camera: { type: 'ken_burns_in' as const, intensity: 0.5 },
        background: { src: `/assets/books/b5/pages/${page_id}/background.png` },
      }));
      store.writeBookSpec('b5', 'zh', BookSpecSchema.parse({ id: 'b5-zh', pages }) as BookSpec);
      genClip(clipPathFor(store, 'b5', 'p1'), 2, 'red');
      genClip(clipPathFor(store, 'b5', 'p2'), 2, 'blue');
      genWav(store.rootPath('books', 'b5', 'pages', 'p1', 'narration.wav'), 1.2);
      store.writePageAssets('b5', 'p1', {
        page_id: 'p1', seed: 1, image_url: '/x', background_url: '/y', subject_urls: [],
        clip_url: '/assets/books/b5/pages/p1/clip.mp4', clip_duration_ms: 2000,
        narration_url: '/assets/books/b5/pages/p1/narration.wav', narration_duration_ms: 1200,
      });
      store.writePageAssets('b5', 'p2', {
        page_id: 'p2', seed: 2, image_url: '/x', background_url: '/y', subject_urls: [],
        clip_url: '/assets/books/b5/pages/p2/clip.mp4', clip_duration_ms: 2000,
      });

      // p2 无旁白：关闭 BGM 时该页为静音，因此整片平均响应显著低于开启 BGM
      const withBgm = await new ConcatExporter({ assets: store }).exportBook('b5', 'zh');
      const wavPath = join(dir, 'bgm', 'canon-piano.wav');
      expect(existsSync(wavPath)).toBe(true);
      const out = join(dir, 'books/b5/exports/zh.mp4');
      expect(probeAudioStreams(out)).toBe(1);
      expect(withBgm.duration_ms).toBe(4200); // p1 旁白延长到 2800 + p2 2000 - 600 转场重叠

      const level = spawnSync('ffmpeg', ['-hide_banner', '-i', out, '-af', 'volumedetect', '-f', 'null', '-']);
      const mean = /mean_volume: (-?[\d.]+) dB/.exec(level.stderr.toString('utf8'))?.[1];
      expect(mean).toBeTruthy();
      expect(Number(mean)).toBeGreaterThan(-45); // 有 BGM 铺底：静音页被钢琴声填满
    },
    60_000,
  );

  it(
    'mixes rain ambience into pages whose scene has rain ambient',
    async () => {
      const pages = ['p1', 'p2'].map((page_id) => ({
        page_id,
        duration_ms: 2000,
        camera: { type: 'ken_burns_in' as const, intensity: 0.5 },
        background: { src: `/assets/books/b6/pages/${page_id}/background.png` },
        ambient: [{ type: 'rain', density: 0.5 }],
      }));
      store.writeBookSpec('b6', 'zh', BookSpecSchema.parse({ id: 'b6-zh', pages }) as BookSpec);
      genClip(clipPathFor(store, 'b6', 'p1'), 2, 'red');
      genClip(clipPathFor(store, 'b6', 'p2'), 2, 'blue');
      genWav(store.rootPath('books', 'b6', 'pages', 'p1', 'narration.wav'), 1);
      store.writePageAssets('b6', 'p1', {
        page_id: 'p1', seed: 1, image_url: '/x', background_url: '/y', subject_urls: [],
        clip_url: '/assets/books/b6/pages/p1/clip.mp4', clip_duration_ms: 2000,
        narration_url: '/assets/books/b6/pages/p1/narration.wav', narration_duration_ms: 1000,
      });
      // p2 无旁白：音效应通过 addSilence 路径混入
      store.writePageAssets('b6', 'p2', {
        page_id: 'p2', seed: 2, image_url: '/x', background_url: '/y', subject_urls: [],
        clip_url: '/assets/books/b6/pages/p2/clip.mp4', clip_duration_ms: 2000,
      });

      // 关闭 BGM，让音量差异只来自音效层
      await new ConcatExporter({ assets: store, bgmPath: null }).exportBook('b6', 'zh');
      const out = join(dir, 'books/b6/exports/zh.mp4');
      expect(probeAudioStreams(out)).toBe(1);
      const level = spawnSync('ffmpeg', ['-hide_banner', '-i', out, '-af', 'volumedetect', '-f', 'null', '-']);
      const mean = Number(/mean_volume: (-?[\d.]+) dB/.exec(level.stderr.toString('utf8'))?.[1]);
      expect(mean).toBeGreaterThan(-60); // 雨声铺底：整片不再是纯静音

      // sfx 关闭后同一片段应显著更安静（p2 完全静音）
      await new ConcatExporter({ assets: store, bgmPath: null, sfx: false }).exportBook('b6', 'zh');
      const levelOff = spawnSync('ffmpeg', ['-hide_banner', '-i', out, '-af', 'volumedetect', '-f', 'null', '-']);
      const meanOff = Number(/mean_volume: (-?[\d.]+) dB/.exec(levelOff.stderr.toString('utf8'))?.[1]);
      expect(meanOff).toBeLessThan(mean);
    },
    60_000,
  );

  it(
    'mixes plot sfx cues (laugh) at their timeline position',
    async () => {
      const pages = ['p1', 'p2'].map((page_id) => ({
        page_id,
        duration_ms: 2000,
        camera: { type: 'ken_burns_in' as const, intensity: 0.5 },
        background: { src: `/assets/books/b7/pages/${page_id}/background.png` },
        // p1 旁白中段有笑声 cue（at=0.5 → 页内 1000ms 处）
        sfx: page_id === 'p1' ? [{ type: 'laugh' as const, at: 0.5 }] : [],
      }));
      store.writeBookSpec('b7', 'zh', BookSpecSchema.parse({ id: 'b7-zh', pages }) as BookSpec);
      genClip(clipPathFor(store, 'b7', 'p1'), 2, 'red');
      genClip(clipPathFor(store, 'b7', 'p2'), 2, 'blue');
      genWav(store.rootPath('books', 'b7', 'pages', 'p1', 'narration.wav'), 1);
      store.writePageAssets('b7', 'p1', {
        page_id: 'p1', seed: 1, image_url: '/x', background_url: '/y', subject_urls: [],
        clip_url: '/assets/books/b7/pages/p1/clip.mp4', clip_duration_ms: 2000,
        narration_url: '/assets/books/b7/pages/p1/narration.wav', narration_duration_ms: 1000,
      });
      store.writePageAssets('b7', 'p2', {
        page_id: 'p2', seed: 2, image_url: '/x', background_url: '/y', subject_urls: [],
        clip_url: '/assets/books/b7/pages/p2/clip.mp4', clip_duration_ms: 2000,
      });

      await new ConcatExporter({ assets: store, bgmPath: null }).exportBook('b7', 'zh');
      // 音效来自 AI 生成素材库（apps/server/assets/sfx-ai），无需运行时渲染缓存
      const out = join(dir, 'books/b7/exports/zh.mp4');
      expect(probeAudioStreams(out)).toBe(1);
      // p2 无旁白无音效：关闭 cue 时整片更安静（p1 只剩旁白）
      const level = spawnSync('ffmpeg', ['-hide_banner', '-i', out, '-af', 'volumedetect', '-f', 'null', '-']);
      const mean = Number(/mean_volume: (-?[\d.]+) dB/.exec(level.stderr.toString('utf8'))?.[1]);
      expect(mean).toBeGreaterThan(-60);

      await new ConcatExporter({ assets: store, bgmPath: null, sfx: false }).exportBook('b7', 'zh');
      const levelOff = spawnSync('ffmpeg', ['-hide_banner', '-i', out, '-af', 'volumedetect', '-f', 'null', '-']);
      const meanOff = Number(/mean_volume: (-?[\d.]+) dB/.exec(levelOff.stderr.toString('utf8'))?.[1]);
      expect(meanOff).toBeLessThan(mean); // 关闭音效层后笑声消失
    },
    60_000,
  );

  it(
    'mixes a sfx cue on a page without narration',
    async () => {
      const pages = ['p1', 'p2'].map((page_id) => ({
        page_id,
        duration_ms: 2000,
        camera: { type: 'ken_burns_in' as const, intensity: 0.5 },
        background: { src: `/assets/books/b8/pages/${page_id}/background.png` },
        // p1 有一条鸟鸣 cue 但无旁白，p2 全静
        sfx: page_id === 'p1' ? [{ type: 'birds' as const, at: 0.5 }] : [],
      }));
      store.writeBookSpec('b8', 'zh', BookSpecSchema.parse({ id: 'b8-zh', pages }) as BookSpec);
      genClip(clipPathFor(store, 'b8', 'p1'), 2, 'red');
      genClip(clipPathFor(store, 'b8', 'p2'), 2, 'blue');
      store.writePageAssets('b8', 'p1', {
        page_id: 'p1', seed: 1, image_url: '/x', background_url: '/y', subject_urls: [],
        clip_url: '/assets/books/b8/pages/p1/clip.mp4', clip_duration_ms: 2000,
      });
      store.writePageAssets('b8', 'p2', {
        page_id: 'p2', seed: 2, image_url: '/x', background_url: '/y', subject_urls: [],
        clip_url: '/assets/books/b8/pages/p2/clip.mp4', clip_duration_ms: 2000,
      });

      await new ConcatExporter({ assets: store, bgmPath: null }).exportBook('b8', 'zh');
      const out = join(dir, 'books/b8/exports/zh.mp4');
      expect(probeAudioStreams(out)).toBe(1);
      const level = spawnSync('ffmpeg', ['-hide_banner', '-i', out, '-af', 'volumedetect', '-f', 'null', '-']);
      const mean = Number(/mean_volume: (-?[\d.]+) dB/.exec(level.stderr.toString('utf8'))?.[1]);
      expect(mean).toBeGreaterThan(-60); // 无旁白页的音效仍可混出

      await new ConcatExporter({ assets: store, bgmPath: null, sfx: false }).exportBook('b8', 'zh');
      // 两页均无旁白：关闭音效层后整片不再混出音轨
      expect(probeAudioStreams(out)).toBe(0);
    },
    60_000,
  );
});
