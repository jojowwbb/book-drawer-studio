import { describe, expect, it } from 'vitest';
import { hashSeed, mulberry32 } from './rng';
import { clamp01, easeInOutSine, easeOutCubic } from './easing';

describe('mulberry32', () => {
  it('is deterministic for the same seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('produces values in [0, 1)', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('differs across seeds', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it('matches golden values (pins the exact algorithm)', () => {
    expect(mulberry32(1)()).toBeCloseTo(0.6270739405881613, 12);
    expect(mulberry32(0)()).toBeCloseTo(0.26642920868471265, 12);
  });
});

describe('hashSeed', () => {
  it('is stable and order-sensitive', () => {
    expect(hashSeed('abc')).toBe(hashSeed('abc'));
    expect(hashSeed('abc')).not.toBe(hashSeed('acb'));
  });

  it('matches golden value (pins FNV-1a 32)', () => {
    expect(hashSeed('abc')).toBe(0x1a47e90b);
  });
});

describe('easing', () => {
  it('bounds easing curves to [0, 1]', () => {
    expect(easeInOutSine(0)).toBeCloseTo(0);
    expect(easeInOutSine(1)).toBeCloseTo(1);
    expect(easeOutCubic(0)).toBeCloseTo(0);
    expect(easeOutCubic(1)).toBeCloseTo(1);
  });

  it('clamps values', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.3)).toBe(0.3);
  });
});
