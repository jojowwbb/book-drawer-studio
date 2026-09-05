import { describe, expect, it } from 'vitest';
import { createAmbientField, sampleAmbient } from './ambient';

const size = { width: 1920, height: 1080 };

describe('createAmbientField', () => {
  it('is deterministic for same seed and type', () => {
    const a = createAmbientField({ type: 'stars_twinkle', density: 0.5 }, 42, size);
    const b = createAmbientField({ type: 'stars_twinkle', density: 0.5 }, 42, size);
    expect(a).toEqual(b);
  });

  it('differs across seeds', () => {
    const a = createAmbientField({ type: 'stars_twinkle', density: 0.5 }, 1, size);
    const b = createAmbientField({ type: 'stars_twinkle', density: 0.5 }, 2, size);
    expect(a).not.toEqual(b);
  });

  it('scales particle count with density', () => {
    const lo = createAmbientField({ type: 'snow', density: 0.2 }, 7, size);
    const hi = createAmbientField({ type: 'snow', density: 0.8 }, 7, size);
    expect(hi.length).toBeGreaterThan(lo.length);
  });

  it('light_rays uses a single global item', () => {
    const field = createAmbientField({ type: 'light_rays', density: 0.5 }, 7, size);
    expect(field).toHaveLength(1);
  });
});

describe('sampleAmbient', () => {
  it('stars stay in the upper 60% and alpha stays in [0, 1]', () => {
    const field = createAmbientField({ type: 'stars_twinkle', density: 0.8 }, 3, size);
    for (let t = 0; t < 8000; t += 500) {
      const state = sampleAmbient(field, 'stars_twinkle', t, size);
      for (const item of state.items) {
        expect(item.y).toBeLessThanOrEqual(size.height * 0.6);
        expect(item.alpha).toBeGreaterThanOrEqual(0);
        expect(item.alpha).toBeLessThanOrEqual(1);
      }
    }
  });

  it('snow falls downward and wraps vertically', () => {
    const field = createAmbientField({ type: 'snow', density: 0.6 }, 5, size);
    const early = sampleAmbient(field, 'snow', 0, size);
    const late = sampleAmbient(field, 'snow', 30000, size);
    expect(early.items.length).toBe(late.items.length);
    for (const item of late.items) {
      expect(item.y).toBeGreaterThanOrEqual(-20);
      expect(item.y).toBeLessThanOrEqual(size.height + 20);
    }
  });

  it('rain items are faster than snow items for same density', () => {
    const seed = 9;
    const snowField = createAmbientField({ type: 'snow', density: 0.5 }, seed, size);
    const rainField = createAmbientField({ type: 'rain', density: 0.5 }, seed, size);
    const snowMove = sampleAmbient(snowField, 'snow', 1000, size).items[0]!.y;
    const rainMove = sampleAmbient(rainField, 'rain', 1000, size).items[0]!.y;
    const snowBase = sampleAmbient(snowField, 'snow', 0, size).items[0]!.y;
    const rainBase = sampleAmbient(rainField, 'rain', 0, size).items[0]!.y;
    expect(Math.abs(rainMove - rainBase)).toBeGreaterThan(Math.abs(snowMove - snowBase));
  });

  it('light_rays pulses alpha of the global overlay', () => {
    const field = createAmbientField({ type: 'light_rays', density: 0.5 }, 3, size);
    const a = sampleAmbient(field, 'light_rays', 0, size).items[0]!.alpha;
    const b = sampleAmbient(field, 'light_rays', 2000, size).items[0]!.alpha;
    expect(a).not.toBe(b);
    expect(a).toBeLessThan(0.15);
  });

  it('clouds drift horizontally and wrap', () => {
    const field = createAmbientField({ type: 'clouds_drift', density: 0.5 }, 3, size);
    for (let t = 0; t < 120000; t += 5000) {
      const state = sampleAmbient(field, 'clouds_drift', t, size);
      for (const item of state.items) {
        expect(item.x).toBeGreaterThanOrEqual(-size.width * 0.2);
        expect(item.x).toBeLessThanOrEqual(size.width * 1.2);
      }
    }
  });
});
