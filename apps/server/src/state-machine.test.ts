import { describe, expect, it } from 'vitest';
import {
  MAX_MODERATION_ROUNDS,
  MAX_PAGE_REGENS,
  MAX_STAGE_RETRIES,
  initialCounters,
  transition,
} from './state-machine';

describe('transition: happy path', () => {
  it('walks created → ready through all generation stages', () => {
    let state = 'created' as const;
    let counters = initialCounters();
    let r = transition(state, { type: 'START' }, counters);
    expect(r.ok && r.state).toBe('story_generating');
    if (!r.ok) return;
    counters = r.counters;
    for (const next of ['story_moderating', 'voice_review', 'pages_generating', 'enhance_generating', 'ready'] as const) {
      r = transition(r.state, { type: 'STAGE_DONE' }, r.counters, { enhance: false });
      expect(r.ok && r.state).toBe(next);
      if (!r.ok) return;
    }
  });

  it('routes through enhance_generating when enhance is on', () => {
    let r = transition('pages_generating', { type: 'STAGE_DONE' }, initialCounters(), { enhance: true });
    expect(r.ok && r.state).toBe('enhance_generating');
    if (!r.ok) return;
    r = transition(r.state, { type: 'STAGE_DONE' }, r.counters, { enhance: true });
    expect(r.ok && r.state).toBe('ready');
  });

  it('ready → exporting → completed', () => {
    let r = transition('ready', { type: 'START_EXPORT' }, initialCounters());
    expect(r.ok && r.state).toBe('exporting');
    if (!r.ok) return;
    r = transition(r.state, { type: 'EXPORT_DONE' }, r.counters);
    expect(r.ok && r.state).toBe('completed');
  });
});

describe('transition: stage retry guard', () => {
  it('stays in stage for MAX_STAGE_RETRIES failures, then fails', () => {
    let counters = initialCounters();
    for (let i = 0; i < MAX_STAGE_RETRIES; i++) {
      const r = transition('pages_generating', { type: 'STAGE_FAILED', error: 'boom' }, counters);
      expect(r.ok && r.state).toBe('pages_generating');
      if (!r.ok) return;
      counters = r.counters;
    }
    const dead = transition('pages_generating', { type: 'STAGE_FAILED', error: 'boom' }, counters);
    expect(dead.ok && dead.state).toBe('failed_pages_generating');
  });
});

describe('transition: moderation loop', () => {
  it(`allows ${MAX_MODERATION_ROUNDS} rejection rounds, then fails`, () => {
    let counters = initialCounters();
    for (let i = 0; i < MAX_MODERATION_ROUNDS; i++) {
      const r = transition('story_moderating', { type: 'TEXT_REJECTED', reason: 'x' }, counters);
      expect(r.ok && r.state).toBe('story_generating');
      if (!r.ok) return;
      counters = r.counters;
    }
    const dead = transition('story_moderating', { type: 'TEXT_REJECTED', reason: 'x' }, counters);
    expect(dead.ok && dead.state).toBe('failed_story_moderating');
  });
});

describe('transition: resume and invalid events', () => {
  it('RESUME returns to the failed stage with retries reset', () => {
    const r = transition('failed_pages_generating', { type: 'RESUME' }, {
      stageRetries: 4, moderationRounds: 0, pageRegens: {},
    });
    expect(r.ok && r.state).toBe('pages_generating');
    expect(r.ok && r.counters.stageRetries).toBe(0);
  });

  it('rejects nonsense transitions', () => {
    expect(transition('created', { type: 'STAGE_DONE' }, initialCounters()).ok).toBe(false);
    expect(transition('ready', { type: 'RESUME' }, initialCounters()).ok).toBe(false);
    expect(transition('completed', { type: 'START' }, initialCounters()).ok).toBe(false);
  });
});

describe('transition: export failure', () => {
  it('EXPORT_FAILED returns to ready so export can be retried', () => {
    let r = transition('ready', { type: 'START_EXPORT' }, initialCounters());
    expect(r.ok && r.state).toBe('exporting');
    if (!r.ok) return;
    r = transition(r.state, { type: 'EXPORT_FAILED', error: 'ffmpeg boom' }, r.counters);
    expect(r.ok && r.state).toBe('ready');
    if (!r.ok) return;
    // 回到 ready 后可再次导出
    expect(transition(r.state, { type: 'START_EXPORT' }, r.counters).ok).toBe(true);
  });

  it('EXPORT_FAILED is rejected outside exporting', () => {
    expect(
      transition('ready', { type: 'EXPORT_FAILED', error: 'x' }, initialCounters()).ok,
    ).toBe(false);
  });
});

describe('page regen limit constant', () => {
  it('is 3', () => {
    expect(MAX_PAGE_REGENS).toBe(3);
  });
});
