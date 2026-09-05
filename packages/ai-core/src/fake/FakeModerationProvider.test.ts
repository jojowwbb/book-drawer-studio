import { describe, expect, it } from 'vitest';
import { FakeModerationProvider } from './FakeModerationProvider';

describe('FakeModerationProvider', () => {
  it('passes by default', async () => {
    const m = new FakeModerationProvider();
    expect(await m.checkText('anything')).toEqual({ verdict: 'pass' });
    expect(await m.checkImage(new Uint8Array(4))).toEqual({ verdict: 'pass' });
  });

  it('rejects text via hook with reason', async () => {
    const m = new FakeModerationProvider({
      rejectTextWhen: (t) => (t.includes('禁词') ? 'contains forbidden word' : undefined),
    });
    expect(await m.checkText('这里有禁词')).toEqual({
      verdict: 'reject',
      reason: 'contains forbidden word',
    });
    expect((await m.checkText('安全文本')).verdict).toBe('pass');
  });

  it('hooks are mutable for multi-round tests', async () => {
    const m = new FakeModerationProvider({ rejectTextWhen: () => 'nope' });
    expect((await m.checkText('x')).verdict).toBe('reject');
    m.rejectTextWhen = undefined;
    expect((await m.checkText('x')).verdict).toBe('pass');
  });
});
