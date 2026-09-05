import { describe, expect, it } from 'vitest';
import { NARRATOR, repairSegments, stripNarrationQuotes } from './voices';

describe('stripNarrationQuotes', () => {
  it('removes Chinese and ASCII quotes', () => {
    expect(stripNarrationQuotes('他说：“好！”')).toBe('他说：好！');
    expect(stripNarrationQuotes('she said "hi"')).toBe('she said hi');
  });
});

describe('repairSegments', () => {
  it('补回两句对白之间被 AI 丢掉的旁白过渡句', () => {
    const narration =
      '邻居王爷爷路过看见了，好心提醒他：“阿牛啊，赶紧修一修吧！”阿牛却摆摆手说：“没事没事，羊不是还在嘛！”';
    const segments = [
      { speaker: '旁白', text: '邻居王爷爷路过看见了，好心提醒他：' },
      { speaker: '王爷爷', text: '阿牛啊，赶紧修一修吧！' },
      { speaker: '阿牛', text: '没事没事，羊不是还在嘛！' },
    ];
    const out = repairSegments(narration, segments);
    // 「阿牛却摆摆手说：」被补回为独立旁白段（位于王爷爷与阿牛之间）
    expect(out.map((s) => s.speaker)).toEqual(['旁白', '王爷爷', '旁白', '阿牛']);
    expect(out[2]!.text).toBe('阿牛却摆摆手说：');
    // 拼接后与去引号 narration 逐字一致
    expect(out.map((s) => s.text).join('')).toBe(stripNarrationQuotes(narration));
  });

  it('补回 narration 末尾遗漏的旁白', () => {
    const narration = '王爷爷说：“快修羊圈。”阿牛听了很难过。';
    const segments = [
      { speaker: '旁白', text: '王爷爷说：' },
      { speaker: '王爷爷', text: '快修羊圈。' },
    ];
    const out = repairSegments(narration, segments);
    expect(out[out.length - 1]).toEqual({ speaker: NARRATOR, text: '阿牛听了很难过。' });
    expect(out.map((s) => s.text).join('')).toBe(stripNarrationQuotes(narration));
  });

  it('segments 已完整覆盖时不改动', () => {
    const narration = '小兔子说：妈妈，我害怕。';
    const segments = [
      { speaker: '旁白', text: '小兔子说：' },
      { speaker: '小兔子', text: '妈妈，我害怕。' },
    ];
    expect(repairSegments(narration, segments)).toEqual(segments);
  });

  it('无分段时回退整段旁白', () => {
    expect(repairSegments('只有一段旁白。', undefined)).toEqual([
      { speaker: NARRATOR, text: '只有一段旁白。' },
    ]);
  });

  it('AI 改写文本导致定位失败时保守保留原段，不丢弃可定位段的旁白', () => {
    const narration = '甲说：“乙。”';
    const segments = [
      { speaker: '旁白', text: '完全不同的开头' },
      { speaker: '甲', text: '乙。' },
    ];
    const out = repairSegments(narration, segments);
    // 定位失败的原段仍保留；后续可定位段前的旁白过渡句「甲说：」被补回
    expect(out.some((s) => s.text === '完全不同的开头')).toBe(true);
    expect(out.some((s) => s.speaker === '甲' && s.text === '乙。')).toBe(true);
    expect(out.some((s) => s.speaker === NARRATOR && s.text === '甲说：')).toBe(true);
  });
});
