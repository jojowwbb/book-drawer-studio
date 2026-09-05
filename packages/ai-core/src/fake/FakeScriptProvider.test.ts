import { describe, expect, it } from 'vitest';
import { ScriptAnalysisSchema } from '../script-schema';
import { NARRATOR } from '../voices';
import { FakeScriptProvider } from './FakeScriptProvider';
import { FakeVideoClipProvider } from './FakeVideoClipProvider';
import { createFakeProjectProviders } from './providers';

describe('FakeScriptProvider', () => {
  it('produces a schema-valid deterministic script with dialogue coverage', async () => {
    const p = new FakeScriptProvider();
    const a = await p.analyzeScript({ source: '一个关于灯塔的故事', style: 'anime', lang: 'zh' });
    expect(() => ScriptAnalysisSchema.parse(a)).not.toThrow();
    const total = a.episodes.reduce((n, e) => n + e.scenes.length, 0);
    expect(total).toBe(4);
    expect(a.characters).toHaveLength(2);
    // 覆盖配音链：至少一场有角色对白段
    const anyDialogue = a.episodes.flatMap((e) => e.scenes).some((s) =>
      s.dialogues.some((d) => d.speaker !== NARRATOR),
    );
    expect(anyDialogue).toBe(true);
  });

  it('is deterministic across calls and bumps version on reject_reason', async () => {
    const p = new FakeScriptProvider();
    const req = { source: '灯塔', style: 'anime', lang: 'zh' } as const;
    const a1 = await p.analyzeScript({ ...req });
    const a2 = await p.analyzeScript({ ...req });
    expect(a2).toEqual(a1);
    const rejected = await p.analyzeScript({ ...req, reject_reason: 'x' });
    expect(rejected.title).not.toBe(a1.title);
  });

  it('honors user-specified title', async () => {
    const a = await new FakeScriptProvider().analyzeScript({
      source: 'x', style: 'anime', lang: 'zh', title: '我的名字',
    });
    expect(a.title).toBe('我的名字');
  });
});

describe('FakeVideoClipProvider', () => {
  it('returns mp4 stub bytes and counts calls', async () => {
    const p = new FakeVideoClipProvider();
    const r = await p.generateClip({ firstFramePng: new Uint8Array(), prompt: 'x' });
    expect(r.video.length).toBeGreaterThan(0);
    expect(String.fromCharCode(...r.video.slice(4, 8))).toBe('ftyp');
    expect(p.calls).toBe(1);
  });

  it('fails the first N calls when configured', async () => {
    const p = new FakeVideoClipProvider({ failTimes: 1 });
    await expect(p.generateClip({ firstFramePng: new Uint8Array(), prompt: 'x' })).rejects.toThrow();
    await expect(p.generateClip({ firstFramePng: new Uint8Array(), prompt: 'x' })).resolves.toBeDefined();
  });
});

describe('createFakeProjectProviders', () => {
  it('wires script/image/videoClip/tts/moderation', () => {
    const bundle = createFakeProjectProviders();
    expect(bundle.script.name).toBe('fake-script');
    expect(bundle.videoClip?.name).toBe('fake-video-clip');
    expect(bundle.tts).toBeDefined();
    expect(bundle.moderation).toBeDefined();
  });
});
