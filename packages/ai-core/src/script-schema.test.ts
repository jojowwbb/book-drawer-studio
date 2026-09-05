import { describe, expect, it } from 'vitest';
import { normalizeScriptLocations, ScriptAnalysisSchema } from './script-schema';

function fixture(overrides: Record<string, unknown> = {}) {
  return {
    title: '海边的灯',
    style_anchor: '日系动画插画',
    lang: 'zh',
    characters: [
      { id: 'c1', name: '林小满', appearance: '齐肩黑发', personality: '倔强' },
      { id: 'c2', name: '老周', appearance: '花白短发', personality: '沉默', voice: 'Arthur' },
    ],
    locations: [
      { id: 'l1', name: '港口', description: '木质栈桥与缆绳，远处一座白色灯塔' },
    ],
    episodes: [
      {
        id: 'e1',
        title: '第一集',
        scenes: [
          { id: 's1', synopsis: '小满来到港口', location_id: 'l1', scene_prompt: '清晨港口，林小满望向海面' },
          { id: 's2', synopsis: '老周递来钥匙', location_id: 'l1', scene_prompt: '老周伸出手', dialogues: [{ speaker: '老周', line: '拿着。' }] },
          { id: 's3', synopsis: '灯亮了', location_id: 'l9', scene_prompt: '灯塔亮起' },
        ],
      },
    ],
    ...overrides,
  };
}

describe('ScriptAnalysisSchema', () => {
  it('accepts a minimal valid analysis and applies defaults', () => {
    const parsed = ScriptAnalysisSchema.parse(fixture());
    expect(parsed.episodes[0]!.scenes[0]!.dialogues).toEqual([]);
    expect(parsed.characters[1]!.voice).toBe('Arthur');
    expect(parsed.characters[0]!.voice).toBeUndefined();
    expect(parsed.locations).toHaveLength(1);
    expect(parsed.episodes[0]!.scenes[0]!.location_id).toBe('l1');
  });

  it('legacy analyses without locations default to an empty list', () => {
    const legacy = fixture();
    delete (legacy as { locations?: unknown }).locations;
    for (const sc of legacy.episodes[0]!.scenes) delete (sc as { location_id?: unknown }).location_id;
    const parsed = ScriptAnalysisSchema.parse(legacy);
    expect(parsed.locations).toEqual([]);
  });

  it('rejects fewer than 3 total scenes', () => {
    const bad = fixture({
      episodes: [{ id: 'e1', title: 'x', scenes: [{ id: 's1', synopsis: 'a', scene_prompt: 'b' }] }],
    });
    expect(ScriptAnalysisSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects more than 24 total scenes', () => {
    const scenes = Array.from({ length: 25 }, (_, i) => ({
      id: `s${i + 1}`,
      synopsis: 'x',
      scene_prompt: 'y',
    }));
    expect(ScriptAnalysisSchema.safeParse(fixture({ episodes: [{ id: 'e1', title: 'x', scenes }] })).success).toBe(
      false,
    );
  });

  it('rejects more than 8 characters and more than 3 episodes', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      id: `c${i}`,
      name: `n${i}`,
      appearance: 'a',
      personality: 'p',
    }));
    expect(ScriptAnalysisSchema.safeParse(fixture({ characters: many })).success).toBe(false);

    const eps = Array.from({ length: 4 }, (_, i) => ({
      id: `e${i}`,
      title: 't',
      scenes: [{ id: `s${i}`, synopsis: 'a', scene_prompt: 'b' }],
    }));
    expect(ScriptAnalysisSchema.safeParse(fixture({ episodes: eps })).success).toBe(false);
  });

  it('rejects more than 6 dialogues in one scene', () => {
    const lines = Array.from({ length: 7 }, () => ({ speaker: '老周', line: 'x' }));
    const bad = fixture({
      episodes: [
        {
          id: 'e1',
          title: 'x',
          scenes: [
            { id: 's1', synopsis: 'a', scene_prompt: 'b', dialogues: lines },
            { id: 's2', synopsis: 'a', scene_prompt: 'b' },
            { id: 's3', synopsis: 'a', scene_prompt: 'b' },
          ],
        },
      ],
    });
    expect(ScriptAnalysisSchema.safeParse(bad).success).toBe(false);
  });

  it('validates sfx cue types against the shared enum', () => {
    const withSfx = fixture({
      episodes: [
        {
          id: 'e1',
          title: 'x',
          scenes: [
            { id: 's1', synopsis: 'a', scene_prompt: 'b', sfx: [{ type: 'whoosh', at: 0.4 }] },
            { id: 's2', synopsis: 'a', scene_prompt: 'b' },
            { id: 's3', synopsis: 'a', scene_prompt: 'b' },
          ],
        },
      ],
    });
    expect(ScriptAnalysisSchema.parse(withSfx).episodes[0]!.scenes[0]!.sfx).toEqual([
      { type: 'whoosh', at: 0.4 },
    ]);

    const bad = JSON.parse(JSON.stringify(withSfx));
    bad.episodes[0].scenes[0].sfx = [
      { type: 'not_a_sound' },
      { type: 'shout', at: 0.2 },
      { type: 'whoosh', at: 0.8 },
    ];
    // 枚举外的幻觉类型逐条丢弃，合法 cue 保留，不拖垮整体 parse
    expect(ScriptAnalysisSchema.parse(bad).episodes[0]!.scenes[0]!.sfx).toEqual([
      { type: 'whoosh', at: 0.8 },
    ]);
  });
});

describe('normalizeScriptLocations', () => {
  it('drops hallucinated location_id references and dedupes location ids', () => {
    const norm = normalizeScriptLocations(ScriptAnalysisSchema.parse(fixture()));
    // s3 引用了不存在的 l9 → 归一化为 undefined（回退无锚定），合法引用保留
    expect(norm.episodes[0]!.scenes[2]!.location_id).toBeUndefined();
    expect(norm.episodes[0]!.scenes[0]!.location_id).toBe('l1');
    // 重复的场景 id 去重保留首个
    const dup = ScriptAnalysisSchema.parse(
      fixture({
        locations: [
          { id: 'l1', name: '港口', description: 'A' },
          { id: 'l1', name: '重复港口', description: 'B' },
        ],
      }),
    );
    const normDup = normalizeScriptLocations(dup);
    expect(normDup.locations).toEqual([{ id: 'l1', name: '港口', description: 'A' }]);
  });
});
