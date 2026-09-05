import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScriptAnalysis } from '@pb/ai-core';
import { AssetStore } from '../asset-store';
import { ProjectRepo, type SceneManifest, type ScriptProjectRecord } from '../project-repo';
import { initialProjectCounters } from '../project-state-machine';
import { ProjectExporter } from './project-exporter';

beforeAll(() => {
  const r = spawnSync('ffmpeg', ['-version']);
  if (r.status !== 0) throw new Error('ffmpeg is required for project export tests');
});

let dir: string;
let store: AssetStore;
let repo: ProjectRepo;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pb-proj-export-'));
  store = new AssetStore(dir);
  repo = new ProjectRepo(store);
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

const script: ScriptAnalysis = {
  title: '测试片',
  style_anchor: '日系动画',
  lang: 'zh',
  locations: [],
  characters: [
    { id: 'c1', name: '小满', appearance: '黑发女孩', personality: '温柔' },
  ],
  episodes: [
    {
      id: 'e1',
      title: '第一集',
      scenes: [
        { id: 's1', synopsis: 'a', scene_prompt: 'p1', dialogues: [], narration: '第一段旁白', sfx: [{ type: 'whoosh', at: 0.4 }] },
        { id: 's2', synopsis: 'b', scene_prompt: 'p2', dialogues: [] },
        { id: 's3', synopsis: 'c', scene_prompt: 'p3', dialogues: [] },
      ],
    },
  ],
};

function manifest(scene_id: string, extra: Partial<SceneManifest>): SceneManifest {
  return { scene_id, seed: 1, ...extra };
}

function createRecord(scenes: SceneManifest[]): void {
  const record: ScriptProjectRecord = {
    id: 'px',
    source: 'x',
    style: 'anime',
    format: 'landscape',
    lang: 'zh',
    state: 'ready',
    counters: initialProjectCounters(),
    progress: { units_done: 3, units_total: 3 },
    characters: [],
    locations: [],
    scenes,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  repo.create(record);
}

describe('ProjectExporter', () => {
  it(
    'joins scene clips with xfade and mixes narration, skipping failed scenes',
    async () => {
      store.writeScript('px', script);
      genClip(join(dir, 'projects/px/scenes/s1/clip.mp4'), 2, 'red');
      genClip(join(dir, 'projects/px/scenes/s3/clip.mp4'), 3, 'blue');
      genWav(join(dir, 'projects/px/scenes/s1/narration.wav'), 1);
      createRecord([
        manifest('s1', {
          clip_url: '/assets/projects/px/scenes/s1/clip.mp4',
          clip_duration_ms: 2000,
          narration_url: '/assets/projects/px/scenes/s1/narration.wav',
          narration_duration_ms: 1000,
        }),
        manifest('s2', { clip_failed: true }), // 失败场跳过
        manifest('s3', {
          clip_url: '/assets/projects/px/scenes/s3/clip.mp4',
          clip_duration_ms: 3000,
        }),
      ]);

      const artifact = await new ProjectExporter({ assets: store, repo, bgmPath: null }).exportProject('px');
      expect(artifact.url).toBe('/assets/projects/px/exports/final.mp4');
      // s1 旁白占用 800+1000+800=2600 > 2000 → 该段延长到 2600；总长 = 2600+3000-600
      expect(artifact.duration_ms).toBe(5000);
      const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
        '-of', 'csv=p=0', join(dir, 'projects/px/exports/final.mp4')]);
      const duration = Number(probe.stdout.toString('utf8').trim());
      expect(duration).toBeGreaterThan(4.6);
      expect(duration).toBeLessThan(5.4);
      const audio = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a',
        '-show_entries', 'stream=index', '-of', 'csv=p=0', join(dir, 'projects/px/exports/final.mp4')]);
      expect(audio.stdout.toString('utf8').trim().split('\n').filter(Boolean).length).toBe(1);
    },
    120_000,
  );

  it('throws when no usable clips exist', async () => {
    store.writeScript('px', script);
    createRecord([manifest('s1', { clip_failed: true })]);
    await expect(
      new ProjectExporter({ assets: store, repo, bgmPath: null }).exportProject('px'),
    ).rejects.toThrow(/no scene clips/);
  });
});
