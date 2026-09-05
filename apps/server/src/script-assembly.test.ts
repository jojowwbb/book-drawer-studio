import { describe, expect, it } from 'vitest';
import type { ScriptAnalysis, ScriptScene } from '@pb/ai-core';
import type { CharacterCard, LocationCard } from './project-repo';
import {
  buildLocationPrompt,
  buildPortraitPrompt,
  buildR2vRequest,
  estimateClipDurationSec,
  R2V_MAX_REFS,
  sceneCast,
  selectR2vCast,
} from './script-assembly';

const card = (over: Partial<CharacterCard> = {}): CharacterCard => ({
  id: 'c1',
  name: '林小满',
  appearance: '齐肩黑发，琥珀色眼睛',
  personality: '倔强',
  versions: [],
  ...over,
});

const loc = (over: Partial<LocationCard> = {}): LocationCard => ({
  id: 'l1',
  name: '港口',
  description: '木质栈桥与缆绳，远处一座白色灯塔',
  versions: [],
  ...over,
});

const script = (over: Partial<ScriptAnalysis> = {}): ScriptAnalysis => ({
  title: '海边的灯',
  style_anchor: '日系动画插画',
  lang: 'zh',
  characters: [card()],
  locations: [],
  episodes: [],
  ...over,
});

const scene = (over: Partial<ScriptScene> = {}): ScriptScene => ({
  id: 's1',
  synopsis: '小满来到港口',
  dialogues: [],
  scene_prompt: '清晨港口，林小满望向海面',
  ...over,
});

const png = (tag: string): Uint8Array => new TextEncoder().encode(tag);

describe('buildPortraitPrompt', () => {
  it('keeps the character card fields verbatim in the prompt', () => {
    const p = buildPortraitPrompt('日系动画插画', card({ costume: '卡其色风衣' }));
    expect(p).toContain('日系动画插画');
    expect(p).toContain('齐肩黑发，琥珀色眼睛');
    expect(p).toContain('卡其色风衣');
    expect(p).toContain('全身立绘');
    expect(p).toContain('不要出现任何文字');
  });
});

describe('sceneCast', () => {
  it('matches characters by dialogue speaker or name in scene_prompt', () => {
    const a = card({ id: 'c1', name: '林小满' });
    const b = card({ id: 'c2', name: '老周' });
    const c = card({ id: 'c3', name: '路人甲' });
    const s = scene({ dialogues: [{ speaker: '老周', line: '拿着。' }] });
    expect(sceneCast([a, b, c], s).map((x) => x.id)).toEqual(['c1', 'c2']);
  });
});

describe('buildLocationPrompt', () => {
  it('anchors the location card verbatim and forbids any characters in frame', () => {
    const p = buildLocationPrompt('日系动画插画', loc(), { width: 1920, height: 1080 });
    expect(p).toContain('日系动画插画');
    expect(p).toContain('场景设定：港口，木质栈桥与缆绳，远处一座白色灯塔');
    expect(p).toContain('不出现任何人物、动物与角色');
    expect(p).toContain('横版 16:9');
    expect(p).toContain('不要出现任何文字');
  });

  it('uses portrait orientation hint for 9:16 sizes', () => {
    const p = buildLocationPrompt('s', loc(), { width: 1080, height: 1920 });
    expect(p).toContain('竖版 9:16');
  });
});

describe('selectR2vCast', () => {
  const a = card({ id: 'c1', name: '林小满' });
  const b = card({ id: 'c2', name: '老周' });
  const c = card({ id: 'c3', name: '海鸥' });
  const d = card({ id: 'c4', name: '船长' });

  it('passes everything through under the cap', () => {
    const s = scene({ dialogues: [{ speaker: '老周', line: '拿着。' }] });
    const r = selectR2vCast([a, b], s, 4);
    expect(r.inMedia.map((x) => x.id)).toEqual(['c1', 'c2']);
    expect(r.described).toEqual([]);
  });

  it('prioritizes speaking characters over silent ones when over the cap', () => {
    const s = scene({ dialogues: [{ speaker: '船长', line: '启航！' }] });
    const r = selectR2vCast([a, b, c, d], s, 2);
    // 船长（说话人）挤掉老周，但 inMedia 保持 cast 原顺序
    expect(r.inMedia.map((x) => x.id)).toEqual(['c1', 'c4']);
    expect(r.described.map((x) => x.id)).toEqual(['c2', 'c3']);
  });
});

describe('buildR2vRequest', () => {
  it('binds 图N to media order: scene image first, then cast portraits', () => {
    const withLoc = script({
      locations: [{ id: 'l1', name: '港口', description: '木质栈桥与缆绳' }],
    });
    const hero = card({ name: '林小满' });
    const r = buildR2vRequest({
      script: withLoc,
      scene: scene({ location_id: 'l1' }),
      locationImage: { name: '港口', png: png('LOC') },
      castIn: [{ card: hero, png: png('HERO') }],
      castOut: [],
    });
    expect(r.referenceImages).toEqual([png('LOC'), png('HERO')]);
    expect(r.prompt).toContain('图1是场景「港口」');
    expect(r.prompt).toContain('图2是角色「林小满」');
    // 有场景图时不再重复文字环境锚定
    expect(r.prompt).not.toContain('环境设定：');
    // scene_prompt 原样在场
    expect(r.prompt).toContain('清晨港口，林小满望向海面');
    // ⑤美学风格 = 画风锚 + 参考图一致性
    expect(r.prompt).toContain('日系动画插画');
    expect(r.prompt).toContain('严格与参考图保持一致');
  });

  it('falls back to a text environment anchor without a scene image', () => {
    const withLoc = script({
      locations: [{ id: 'l1', name: '港口', description: '木质栈桥与缆绳' }],
    });
    const r = buildR2vRequest({
      script: withLoc,
      scene: scene({ location_id: 'l1' }),
      castIn: [],
      castOut: [],
    });
    expect(r.referenceImages).toEqual([]);
    expect(r.prompt).toContain('环境设定：港口——木质栈桥与缆绳');
    expect(r.prompt).not.toContain('图1');
  });

  it('describes squeezed-out characters by appearance instead of images', () => {
    const old = card({ id: 'c2', name: '老周', appearance: '花白短发', costume: '深蓝工装' });
    const r = buildR2vRequest({
      script: script(),
      scene: scene(),
      castIn: [{ card: card(), png: png('HERO') }],
      castOut: [old],
    });
    expect(r.referenceImages).toEqual([png('HERO')]);
    expect(r.prompt).toContain('另有角色 老周——花白短发，深蓝工装');
  });

  it('dialogue scenes open only the speaker’s mouth; narration-only scenes close all mouths', () => {
    const talking = buildR2vRequest({
      script: script(),
      scene: scene({
        narration: '灯还亮着。',
        dialogues: [{ speaker: '老周', line: '回去吧。' }],
        camera: '镜头从特写缓慢拉远并微微上仰',
      }),
      castIn: [{ card: card(), png: png('H') }],
      castOut: [],
    });
    expect(talking.prompt).toContain('老周');
    expect(talking.prompt).toContain('嘴唇轻微开合');
    // ③镜头运动用 AI 给的 camera
    expect(talking.prompt).toContain('镜头从特写缓慢拉远并微微上仰');
    // 旁白原文与台词文本都不得进入 r2v prompt（防口型错乱/画面文字）
    expect(talking.prompt).not.toContain('灯还亮着');
    expect(talking.prompt).not.toContain('回去吧');

    const silent = buildR2vRequest({
      script: script(),
      scene: scene({ narration: '夜风吹过港口。' }),
      castIn: [{ card: card(), png: png('H') }],
      castOut: [],
    });
    expect(silent.prompt).not.toContain('夜风吹过港口');
    expect(silent.prompt).toContain('嘴唇全程保持闭合');
    expect(silent.prompt).toContain('镜头缓慢向主体轻微推近');
  });
});

describe('estimateClipDurationSec', () => {
  it('estimates from spoken text (zh ~4.5 chars/sec), clamped to [3, 10]', () => {
    // 45 个有效字 ≈ 10s → clamp 10
    const long = '一'.repeat(45);
    expect(estimateClipDurationSec(script(), scene({ narration: long }))).toBe(10);
    // 空台词兜底 5s
    expect(estimateClipDurationSec(script(), scene())).toBe(5);
  });

  it('estimates from words for english scripts', () => {
    const s = script({ lang: 'en' });
    // 14 词 ≈ 5s
    const words = Array.from({ length: 14 }, (_, i) => `w${i}`).join(' ');
    expect(estimateClipDurationSec(s, scene({ narration: words }))).toBe(5);
  });
});

describe('R2V_MAX_REFS', () => {
  it('matches the wan2.7-r2v media limit', () => {
    expect(R2V_MAX_REFS).toBe(5);
  });
});
