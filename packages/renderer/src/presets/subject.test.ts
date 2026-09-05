import { describe, expect, it } from 'vitest';
import { sampleSubject } from './subject';

describe('sampleSubject', () => {
  it('no fx yields identity state', () => {
    const s = sampleSubject([], 1234, 0);
    expect(s).toEqual({ scale: 1, rotation: 0, dx: 0, dy: 0, alpha: 1 });
  });

  it('breathe oscillates scale around 1 with 2% amplitude', () => {
    const s = sampleSubject(['breathe'], 800, 0);
    expect(s.scale).toBeGreaterThan(1);
    expect(s.scale).toBeLessThanOrEqual(1.021);
    const back = sampleSubject(['breathe'], 3200, 0);
    expect(back.scale).toBeCloseTo(1, 5);
  });

  it('sway stays within ±1.5 degrees', () => {
    for (let t = 0; t < 8000; t += 250) {
      const s = sampleSubject(['sway'], t, 0);
      expect(Math.abs(s.rotation)).toBeLessThanOrEqual((1.5 * Math.PI) / 180 + 1e-9);
    }
  });

  it('float stays within ±4px vertical', () => {
    for (let t = 0; t < 8000; t += 250) {
      const s = sampleSubject(['float'], t, 0);
      expect(Math.abs(s.dy)).toBeLessThanOrEqual(4 + 1e-9);
    }
  });

  it('enter_left slides from -80px and fades in over 1200ms', () => {
    const start = sampleSubject(['enter_left'], 0, 0);
    expect(start.dx).toBeCloseTo(-80);
    expect(start.alpha).toBeCloseTo(0);
    const done = sampleSubject(['enter_left'], 1200, 0);
    expect(done.dx).toBeCloseTo(0);
    expect(done.alpha).toBeCloseTo(1);
  });

  it('enter_right mirrors enter_left', () => {
    expect(sampleSubject(['enter_right'], 0, 0).dx).toBeCloseTo(80);
  });

  it('fx combine multiplicatively for scale and additively for offsets', () => {
    const s = sampleSubject(['breathe', 'float', 'enter_left'], 600, 0);
    expect(s.dx).toBeLessThan(0);
    expect(s.dy).not.toBe(0);
    expect(s.scale).not.toBe(1);
    expect(s.alpha).toBeLessThan(1);
  });

  it('phase offset differs by subject index', () => {
    const a = sampleSubject(['breathe'], 400, 0);
    const b = sampleSubject(['breathe'], 400, 1);
    expect(a.scale).not.toBeCloseTo(b.scale, 5);
  });
});
