import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFakeProjectProviders,
  FakeImageProvider,
  FakeModerationProvider,
  type ImageProvider,
  type ProjectProviders,
} from '@pb/ai-core';
import { existsSync } from 'node:fs';
import { AssetStore } from './asset-store';
import { EventHub, type ProjectHubMessage } from './events';
import { ProjectRepo, type CharacterCard, type LocationCard, type ScriptProjectRecord } from './project-repo';
import { initialProjectCounters } from './project-state-machine';
import {
  initCharacterCards,
  initLocationCards,
  PORTRAIT_VERSIONS,
  ScriptPipeline,
  scriptFullText,
} from './script-pipeline';

let dir: string;
let store: AssetStore;
let repo: ProjectRepo;
let hub: EventHub<ProjectHubMessage>;
let providers: ProjectProviders;
let pipeline: ScriptPipeline;
const events: ProjectHubMessage[] = [];

const size = { width: 64, height: 36 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pb-project-'));
  store = new AssetStore(dir);
  repo = new ProjectRepo(store);
  hub = new EventHub();
  hub.subscribe('p1', (m) => events.push(m));
  providers = createFakeProjectProviders();
  pipeline = new ScriptPipeline(providers, repo, store, hub, {
    pageSize: size,
    probeDurationMs: async () => 1800,
  });
  events.length = 0;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function createProject(overrides: Partial<ScriptProjectRecord> = {}): ScriptProjectRecord {
  return repo.create({
    id: 'p1',
    source: '一个关于灯塔与告别的故事',
    style: 'anime',
    format: 'landscape',
    lang: 'zh',
    state: 'created',
    counters: initialProjectCounters(),
    progress: { units_done: 0, units_total: 0 },
    characters: [],
    locations: [],
    scenes: [],
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  });
}

describe('ScriptPipeline front half', () => {
  it('runs created → awaiting_character_confirmation with 3 versions per character AND location', async () => {
    createProject();
    await pipeline.run('p1');
    const record = repo.get('p1')!;
    expect(record.state).toBe('awaiting_character_confirmation');
    expect(record.characters).toHaveLength(2);
    for (const card of record.characters) {
      expect(card.versions.filter((v) => v.url)).toHaveLength(PORTRAIT_VERSIONS);
    }
    // 场景资产与角色对称：fake 剧本 4 地点，每地点 3 版场景图
    expect(record.locations).toHaveLength(4);
    for (const loc of record.locations) {
      expect(loc.versions.filter((v) => v.url)).toHaveLength(PORTRAIT_VERSIONS);
    }
    expect(events.some((e) => e.type === 'location' && e.status === 'ready')).toBe(true);
    // script.json 与立绘文件落盘
    expect(store.readScript('p1').episodes[0]!.scenes.length).toBeGreaterThan(0);
    expect(record.characters[0]!.versions[0]!.url).toMatch(/^\/assets\/projects\/p1\/characters\/c1\/v1\.png$/);
    expect(record.locations[0]!.versions[0]!.url).toMatch(/^\/assets\/projects\/p1\/locations\/l1\/v1\.png$/);
    // 卡点不发 completed
    expect(events.some((e) => e.type === 'completed')).toBe(false);
    expect(events.some((e) => e.type === 'state' && e.state === 'awaiting_character_confirmation')).toBe(true);
  });

  it('re-running while awaiting does nothing (idempotent checkpoint)', async () => {
    createProject();
    await pipeline.run('p1');
    const before = repo.get('p1')!.characters[0]!.versions.length;
    await pipeline.run('p1');
    expect(repo.get('p1')!.state).toBe('awaiting_character_confirmation');
    expect(repo.get('p1')!.characters[0]!.versions).toHaveLength(before);
  });

  it('confirm requires every character and referenced location selected, merges confirmed look into script.json', async () => {
    createProject();
    await pipeline.run('p1');
    expect(() => pipeline.confirmCharacters('p1')).toThrow(/characters not selected/);

    const record = repo.get('p1')!;
    for (const card of record.characters) {
      pipeline.selectPortrait('p1', card.id, card.versions[1]!.seed);
    }
    // 角色全选定但场景未选：confirm 仍拒绝，错误信息区分 locations
    expect(() => pipeline.confirmCharacters('p1')).toThrow(/locations not selected/);

    for (const loc of repo.get('p1')!.locations) {
      pipeline.selectLocation('p1', loc.id, loc.versions[1]!.seed);
    }
    const after = pipeline.confirmCharacters('p1');
    expect(after.state).toBe('storyboard_review');

    // 改描述定稿后写回 script
    const script = store.readScript('p1');
    expect(script.characters[0]!.appearance).toBe(after.characters[0]!.appearance);
    expect(script.locations[0]!.description).toBe(after.locations[0]!.description);
  });

  it('select rejects seeds that have no saved version', async () => {
    createProject();
    await pipeline.run('p1');
    const card = repo.get('p1')!.characters[0]!;
    expect(() => pipeline.selectPortrait('p1', card.id, 12345)).toThrow(/not found/);
    const loc = repo.get('p1')!.locations[0]!;
    expect(() => pipeline.selectLocation('p1', loc.id, 12345)).toThrow(/not found/);
    expect(() => pipeline.selectLocation('p1', 'nope', 1)).toThrow(/location not found/);
  });

  it('select and confirm are rejected outside the checkpoint state', async () => {
    createProject();
    expect(() => pipeline.selectPortrait('p1', 'c1', 1)).toThrow(/awaiting/);
    expect(() => pipeline.confirmCharacters('p1')).toThrow(/awaiting/);
  });

  it('regenerate with a new description invalidates old versions and produces a fresh round', async () => {
    createProject();
    await pipeline.run('p1');
    const card = repo.get('p1')!.characters[0]!;
    pipeline.selectPortrait('p1', card.id, card.versions[0]!.seed);

    await pipeline.regeneratePortrait('p1', card.id, { appearance: '银色短发，绿色眼睛' });
    const next = repo.get('p1')!.characters[0]!;
    expect(next.appearance).toBe('银色短发，绿色眼睛');
    expect(next.selected).toBeUndefined();
    // 旧版本作废，新一轮 3 版
    expect(next.versions.filter((v) => v.url)).toHaveLength(PORTRAIT_VERSIONS);
    expect(repo.get('p1')!.counters.portraitRegens[card.id]).toBe(1);
  });

  it('regenerate moderates the new description before accepting it', async () => {
    const mod = new FakeModerationProvider({
      rejectTextWhen: (t) => (t.includes('禁忌') ? 'inappropriate' : undefined),
    });
    providers = { ...providers, moderation: mod };
    pipeline = new ScriptPipeline(providers, repo, store, hub, { pageSize: size });
    createProject();
    await pipeline.run('p1');
    const card = repo.get('p1')!.characters[0]!;
    await expect(
      pipeline.regeneratePortrait('p1', card.id, { appearance: '身上纹着禁忌符号' }),
    ).rejects.toThrow(/rejected/);
    // 描述未被污染
    expect(repo.get('p1')!.characters[0]!.appearance).toBe(card.appearance);
  });

  it('regenerate enforces the per-character limit', async () => {
    createProject();
    await pipeline.run('p1');
    const card = repo.get('p1')!.characters[0]!;
    for (let i = 0; i < 3; i++) {
      await pipeline.regeneratePortrait('p1', card.id, { appearance: `描述 ${i}` });
    }
    await expect(pipeline.regeneratePortrait('p1', card.id)).rejects.toThrow(/limit/);
  });

  it('regenerateLocation with a new description invalidates old versions and produces a fresh round', async () => {
    createProject();
    await pipeline.run('p1');
    const loc = repo.get('p1')!.locations[0]!;
    pipeline.selectLocation('p1', loc.id, loc.versions[0]!.seed);

    await pipeline.regenerateLocation('p1', loc.id, '夜晚的港口，灯塔光束扫过海面');
    const next = repo.get('p1')!.locations[0]!;
    expect(next.description).toBe('夜晚的港口，灯塔光束扫过海面');
    expect(next.selected).toBeUndefined();
    expect(next.versions.filter((v) => v.url)).toHaveLength(PORTRAIT_VERSIONS);
    expect(repo.get('p1')!.counters.locationRegens[loc.id]).toBe(1);
  });

  it('regenerateLocation moderates the new description and enforces its own limit', async () => {
    const mod = new FakeModerationProvider({
      rejectTextWhen: (t) => (t.includes('禁忌') ? 'inappropriate' : undefined),
    });
    providers = { ...providers, moderation: mod };
    pipeline = new ScriptPipeline(providers, repo, store, hub, { pageSize: size });
    createProject();
    await pipeline.run('p1');
    const loc = repo.get('p1')!.locations[0]!;
    await expect(
      pipeline.regenerateLocation('p1', loc.id, '禁忌之地'),
    ).rejects.toThrow(/rejected/);
    expect(repo.get('p1')!.locations[0]!.description).toBe(loc.description);

    providers = createFakeProjectProviders();
    pipeline = new ScriptPipeline(providers, repo, store, hub, { pageSize: size });
    for (let i = 0; i < 3; i++) {
      await pipeline.regenerateLocation('p1', loc.id, `场景描述 ${i}`);
    }
    await expect(pipeline.regenerateLocation('p1', loc.id)).rejects.toThrow(/limit/);
  });

  it('text rejection loops back to analysis and records the reason', async () => {
    let textChecks = 0;
    const mod = new FakeModerationProvider({
      rejectTextWhen: () => (++textChecks === 1 ? 'too dark' : undefined),
    });
    providers = { ...createFakeProjectProviders(), moderation: mod };
    pipeline = new ScriptPipeline(providers, repo, store, hub, { pageSize: size });
    createProject();
    await pipeline.run('p1');
    const record = repo.get('p1')!;
    expect(record.state).toBe('awaiting_character_confirmation');
    expect(record.counters.moderationRounds).toBe(1);
    expect(record.last_reject_reason).toBe('too dark');
  });

  it('fails the stage when every portrait generation is rejected', async () => {
    const mod = new FakeModerationProvider({ rejectImageWhen: () => 'nsfw' });
    providers = { ...createFakeProjectProviders(), moderation: mod };
    pipeline = new ScriptPipeline(providers, repo, store, hub, { pageSize: size });
    createProject();
    await pipeline.run('p1');
    expect(repo.get('p1')!.state).toBe('failed_portraits_generating');
    expect(events.some((e) => e.type === 'failed')).toBe(true);
  });

  it('partial portrait failures mark versions failed but still reach the checkpoint', async () => {
    // 按角色名定向失败：c1 的立绘全挂、c2 正常，验证「单角色失败不阻塞卡点」
    const base = new FakeImageProvider();
    const partial: ImageProvider = {
      name: 'partial-image',
      generateImage: (req) =>
        req.prompt.includes('林小满')
          ? Promise.reject(new Error('image service down'))
          : base.generateImage(req),
    };
    providers = { ...providers, image: partial };
    pipeline = new ScriptPipeline(providers, repo, store, hub, { pageSize: size });
    createProject();
    await pipeline.run('p1');
    const record = repo.get('p1')!;
    expect(record.state).toBe('awaiting_character_confirmation');
    const [c1, c2] = record.characters;
    expect(c1!.versions.every((v) => v.failed)).toBe(true);
    expect(c1!.versions[0]!.error).toContain('image service down');
    expect(c2!.versions.filter((v) => v.url)).toHaveLength(PORTRAIT_VERSIONS);
  });

  it('user-specified title force-overrides the AI title', async () => {
    createProject({ title: '我的灯塔' });
    await pipeline.run('p1');
    expect(store.readScript('p1').title).toBe('我的灯塔');
  });
});

/** 走完前半段并在卡点确认全部角色与场景，返回后 state=storyboard_review */
async function runToConfirmed(): Promise<void> {
  await pipeline.run('p1');
  for (const card of repo.get('p1')!.characters) {
    pipeline.selectPortrait('p1', card.id, card.versions[0]!.seed);
  }
  for (const loc of repo.get('p1')!.locations) {
    pipeline.selectLocation('p1', loc.id, loc.versions[0]!.seed);
  }
  pipeline.confirmCharacters('p1');
}

/** 逐场点「生成视频」（r2v 直出）把整个工作台跑完 */
async function generateAllScenes(): Promise<void> {
  for (const m of repo.get('p1')!.scenes) {
    await pipeline.generateSceneClip('p1', m.scene_id);
  }
}

describe('ScriptPipeline storyboard workbench', () => {
  it('confirm parks at storyboard_review with scene manifests initialized (nothing auto-generated)', async () => {
    createProject();
    await runToConfirmed();
    const record = repo.get('p1')!;
    expect(record.state).toBe('storyboard_review');
    expect(record.scenes.length).toBeGreaterThan(0);
    // 未点生成前无任何产物
    for (const m of record.scenes) {
      expect(m.clip_url).toBeUndefined();
    }
    expect(record.progress.units_total).toBe(record.scenes.length);
    // run() 不再自动推进分镜阶段
    await pipeline.run('p1');
    expect(repo.get('p1')!.state).toBe('storyboard_review');
  });

  it('per-scene r2v clip drives storyboard_review → ready with all artifacts', async () => {
    createProject();
    await runToConfirmed();
    const sceneId = repo.get('p1')!.scenes[0]!.scene_id;
    await pipeline.generateSceneClip('p1', sceneId);
    const m = repo.get('p1')!.scenes.find((x) => x.scene_id === sceneId)!;
    expect(m.clip_url).toMatch(/clip\.mp4$/);
    expect(m.clip_duration_ms).toBe(1800);
    expect(m.narration_url).toMatch(/narration\.wav$/);
    expect(existsSync(join(dir, 'projects', 'p1', 'scenes', sceneId, 'clip.mp4'))).toBe(true);

    await generateAllScenes();
    const record = repo.get('p1')!;
    expect(record.state).toBe('ready');
    expect(record.scenes.every((s) => s.clip_url)).toBe(true);
    expect(record.progress).toEqual({ units_done: record.scenes.length, units_total: record.scenes.length });
    expect(events.some((e) => e.type === 'completed')).toBe(true);
  });

  it('r2v request carries the selected scene image as 图1 and portraits as 图N in media order', async () => {
    createProject();
    await runToConfirmed();
    const reqs: { refs?: Uint8Array[]; prompt: string; ratio?: string }[] = [];
    providers = {
      ...providers,
      videoClip: {
        name: 'spy-video',
        generateClip: (r) => {
          reqs.push({ refs: r.referenceImages, prompt: r.prompt, ratio: r.ratio });
          return Promise.resolve({ video: new Uint8Array([0]) });
        },
      },
    };
    pipeline = new ScriptPipeline(providers, repo, store, hub, { pageSize: size, probeDurationMs: async () => 1800 });
    const sceneId = repo.get('p1')!.scenes[0]!.scene_id;
    await pipeline.generateSceneClip('p1', sceneId);
    expect(reqs).toHaveLength(1);
    const { refs, prompt, ratio } = reqs[0]!;
    // 该场引用 l1 且已选定 + 出场角色林小满（scene_prompt 含全名）→ 2 张参考图
    expect(refs!.length).toBe(2);
    expect(prompt).toContain('图1是场景「清晨的港口」');
    expect(prompt).toContain('图2是角色「林小满」');
    expect(ratio).toBe('16:9');
  });

  it('r2v failure marks clip_failed and keeps the project in the workbench', async () => {
    createProject();
    await runToConfirmed();
    const sceneId = repo.get('p1')!.scenes[0]!.scene_id;
    providers = {
      ...providers,
      videoClip: { name: 'flaky', generateClip: () => Promise.reject(new Error('r2v quota')) },
    };
    pipeline = new ScriptPipeline(providers, repo, store, hub, { pageSize: size, probeDurationMs: async () => 1800 });
    await expect(pipeline.generateSceneClip('p1', sceneId)).rejects.toThrow(/r2v quota/);
    const m = repo.get('p1')!.scenes.find((x) => x.scene_id === sceneId)!;
    expect(m.clip_failed).toBe(true);
    expect(repo.get('p1')!.state).toBe('storyboard_review');
  });

  it('a scene with no reference images at all is rejected (legacy project fallback)', async () => {
    createProject();
    await runToConfirmed();
    // 清空全部选定资产 → 无任何参考图
    const cur = repo.get('p1')!;
    repo.update({
      ...cur,
      characters: cur.characters.map((c) => ({ ...c, selected: undefined })),
      locations: cur.locations.map((l) => ({ ...l, selected: undefined })),
    });
    const sceneId = repo.get('p1')!.scenes[0]!.scene_id;
    await expect(pipeline.generateSceneClip('p1', sceneId)).rejects.toThrow(/no reference images/);
  });

  it('regenerateScene redraws the r2v clip and keeps narration', async () => {
    createProject();
    await runToConfirmed();
    await generateAllScenes();
    expect(repo.get('p1')!.state).toBe('ready');
    const before = repo.get('p1')!.scenes.find((m) => m.scene_id === 's2')!;
    await pipeline.regenerateScene('p1', 's2');
    const after = repo.get('p1')!.scenes.find((m) => m.scene_id === 's2')!;
    expect(after.seed).not.toBe(before.seed);
    expect(after.narration_url).toBe(before.narration_url);
    expect(after.clip_url).toMatch(/clip\.mp4$/);
    expect(repo.get('p1')!.counters.sceneRegens.s2).toBe(1);
    // 齐备后自动回到 ready
    expect(repo.get('p1')!.state).toBe('ready');
  });

  it('regenerateScene has no attempt limit and rejects unknown scenes', async () => {
    createProject();
    await runToConfirmed();
    await generateAllScenes();
    await expect(pipeline.regenerateScene('p1', 'nope')).rejects.toThrow(/not found/);
    for (let i = 0; i < 5; i++) await pipeline.regenerateScene('p1', 's1');
    expect(repo.get('p1')!.counters.sceneRegens.s1).toBe(5);
  });

  it('portrait format renders location images at 1080x1920', async () => {
    const dims: { w: number; h: number }[] = [];
    const base = new FakeImageProvider();
    providers = {
      ...providers,
      image: {
        name: 'spy-size',
        generateImage: (req) => (dims.push({ w: req.width, h: req.height }), base.generateImage(req)),
      },
    };
    pipeline = new ScriptPipeline(providers, repo, store, hub, { pageSize: size, probeDurationMs: async () => 1800 });
    createProject({ format: 'portrait' });
    await pipeline.run('p1');
    expect(dims.some((d) => d.w === 1080 && d.h === 1920)).toBe(true);
  });
});

describe('scriptFullText / initCharacterCards', () => {
  it('scriptFullText includes character and dialogue content for moderation', async () => {
    const script = await createFakeProjectProviders().script.analyzeScript({
      source: '灯塔', style: 'anime', lang: 'zh',
    });
    const text = scriptFullText(script);
    expect(text).toContain('林小满');
    expect(text).toContain('老周');
    expect(text).toContain('别怕，往前走。');
  });

  it('initCharacterCards preserves previous edited look and selection by id', () => {
    const script = {
      title: 't', style_anchor: 's', lang: 'zh',
      characters: [{ id: 'c1', name: 'A', appearance: 'raw', personality: 'p' }],
      episodes: [],
    };
    const prev: CharacterCard[] = [
      { id: 'c1', name: 'A', appearance: 'edited', personality: 'p', versions: [{ seed: 7, url: '/x.png' }], selected: 7 },
    ];
    const cards = initCharacterCards(script as never, prev);
    expect(cards[0]!.appearance).toBe('edited');
    expect(cards[0]!.selected).toBe(7);
    expect(cards[0]!.versions).toHaveLength(1);
  });
});
