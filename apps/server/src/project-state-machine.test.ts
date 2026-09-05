import { describe, expect, it } from 'vitest';
import {
  initialProjectCounters,
  MAX_MODERATION_ROUNDS,
  MAX_STAGE_RETRIES,
  transitionProject,
} from './project-state-machine';

describe('project state machine', () => {
  it('walks the happy path and parks at the character checkpoint after portraits', () => {
    let state = transitionProject('created', { type: 'START' }, initialProjectCounters());
    expect(state).toMatchObject({ ok: true, state: 'script_analyzing' });
    state = transitionProject('script_analyzing', { type: 'STAGE_DONE' }, initialProjectCounters());
    expect(state).toMatchObject({ ok: true, state: 'script_moderating' });
    state = transitionProject('script_moderating', { type: 'STAGE_DONE' }, initialProjectCounters());
    expect(state).toMatchObject({ ok: true, state: 'portraits_generating' });
    state = transitionProject('portraits_generating', { type: 'STAGE_DONE' }, initialProjectCounters());
    expect(state).toMatchObject({ ok: true, state: 'awaiting_character_confirmation' });
    state = transitionProject(
      'awaiting_character_confirmation',
      { type: 'CONFIRM_CHARACTERS' },
      initialProjectCounters(),
    );
    expect(state).toMatchObject({ ok: true, state: 'storyboard_review' });
  });

  it('storyboard workbench opens when all scene clips are ready and reopens on redraw', () => {
    expect(
      transitionProject('storyboard_review', { type: 'STORYBOARD_DONE' }, initialProjectCounters()),
    ).toMatchObject({ ok: true, state: 'ready' });
    expect(
      transitionProject('ready', { type: 'STORYBOARD_REOPEN' }, initialProjectCounters()),
    ).toMatchObject({ ok: true, state: 'storyboard_review' });
    // 非法迁移
    expect(
      transitionProject('awaiting_character_confirmation', { type: 'STORYBOARD_DONE' }, initialProjectCounters()).ok,
    ).toBe(false);
    expect(
      transitionProject('completed', { type: 'STORYBOARD_REOPEN' }, initialProjectCounters()).ok,
    ).toBe(false);
    // 工作台未集齐片段前不允许导出
    expect(
      transitionProject('storyboard_review', { type: 'START_EXPORT' }, initialProjectCounters()).ok,
    ).toBe(false);
  });

  it('export flow: ready -> exporting -> completed, failure back to ready', () => {
    expect(
      transitionProject('ready', { type: 'START_EXPORT' }, initialProjectCounters()),
    ).toMatchObject({ ok: true, state: 'exporting' });
    expect(
      transitionProject('exporting', { type: 'EXPORT_DONE' }, initialProjectCounters()),
    ).toMatchObject({ ok: true, state: 'completed' });
    expect(
      transitionProject('exporting', { type: 'EXPORT_FAILED', error: 'x' }, initialProjectCounters()),
    ).toMatchObject({ ok: true, state: 'ready' });
  });

  it('rejects generation events while awaiting confirmation', () => {
    for (const ev of [
      { type: 'START' as const },
      { type: 'STAGE_DONE' as const },
      { type: 'RESUME' as const },
      { type: 'START_EXPORT' as const },
    ]) {
      const r = transitionProject('awaiting_character_confirmation', ev, initialProjectCounters());
      expect(r.ok).toBe(false);
    }
  });

  it('CONFIRM only works from the checkpoint state', () => {
    for (const s of ['created', 'script_analyzing', 'ready', 'completed'] as const) {
      expect(transitionProject(s, { type: 'CONFIRM_CHARACTERS' }, initialProjectCounters()).ok).toBe(
        false,
      );
    }
  });

  it('stage failures retry up to the limit then land on failed_<stage>', () => {
    let counters = initialProjectCounters();
    for (let i = 0; i < MAX_STAGE_RETRIES; i++) {
      const r = transitionProject('portraits_generating', { type: 'STAGE_FAILED', error: 'boom' }, counters);
      expect(r.ok && r.state).toBe('portraits_generating');
      counters = (r as { counters: typeof counters }).counters;
    }
    const r = transitionProject('portraits_generating', { type: 'STAGE_FAILED', error: 'boom' }, counters);
    expect(r).toMatchObject({ ok: true, state: 'failed_portraits_generating' });
  });

  it('RESUME returns to the failed stage with a fresh retry budget', () => {
    const r = transitionProject('failed_portraits_generating', { type: 'RESUME' }, {
      ...initialProjectCounters(),
      stageRetries: 9,
    });
    expect(r).toMatchObject({ ok: true, state: 'portraits_generating' });
    if (r.ok) expect(r.counters.stageRetries).toBe(0);
  });

  it('text rejection loops back to script_analyzing until moderation rounds exhausted', () => {
    let counters = initialProjectCounters();
    for (let i = 0; i < MAX_MODERATION_ROUNDS; i++) {
      const r = transitionProject('script_moderating', { type: 'TEXT_REJECTED', reason: 'x' }, counters);
      expect(r.ok && r.state).toBe('script_analyzing');
      counters = (r as { counters: typeof counters }).counters;
    }
    const r = transitionProject('script_moderating', { type: 'TEXT_REJECTED', reason: 'x' }, counters);
    expect(r).toMatchObject({ ok: true, state: 'failed_script_moderating' });
  });

  it('TEXT_REJECTED is only valid from script_moderating', () => {
    expect(
      transitionProject('awaiting_character_confirmation', { type: 'TEXT_REJECTED', reason: 'x' }, initialProjectCounters()).ok,
    ).toBe(false);
  });
});
