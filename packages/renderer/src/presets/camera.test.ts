import { describe, expect, it } from 'vitest';
import { sampleCamera } from './camera';

const size = { width: 1920, height: 1080 };
const spec = (type: string, intensity = 0.5) => ({ type: type as never, intensity });

describe('sampleCamera', () => {
  it('ken_burns_in zooms from 1.0 toward 1+amp over the page', () => {
    const start = sampleCamera(spec('ken_burns_in'), 0, 8000, size);
    const end = sampleCamera(spec('ken_burns_in'), 8000, 8000, size);
    expect(start.scale).toBeCloseTo(1.0);
    expect(end.scale).toBeGreaterThan(1.04);
    expect(end.scale).toBeLessThanOrEqual(1.12);
    expect(start.offsetX).toBe(0);
  });

  it('ken_burns_out is the inverse', () => {
    const start = sampleCamera(spec('ken_burns_out'), 0, 8000, size);
    const end = sampleCamera(spec('ken_burns_out'), 8000, 8000, size);
    expect(start.scale).toBeGreaterThan(end.scale);
    expect(end.scale).toBeCloseTo(1.0);
  });

  it('pan_left sweeps offsetX from positive to negative at fixed scale', () => {
    const start = sampleCamera(spec('pan_left'), 0, 8000, size);
    const end = sampleCamera(spec('pan_left'), 8000, 8000, size);
    expect(start.scale).toBe(end.scale);
    expect(start.offsetX).toBeGreaterThan(0);
    expect(end.offsetX).toBeLessThan(0);
    expect(start.offsetX).toBeCloseTo(-end.offsetX);
  });

  it('pan_right mirrors pan_left', () => {
    const l = sampleCamera(spec('pan_left'), 4000, 8000, size);
    const r = sampleCamera(spec('pan_right'), 4000, 8000, size);
    expect(r.offsetX).toBeCloseTo(-l.offsetX);
  });

  it('static_breath oscillates with small amplitude and returns to start each period', () => {
    const a = sampleCamera(spec('static_breath'), 0, 8000, size);
    const b = sampleCamera(spec('static_breath'), 6000, 8000, size);
    expect(a.scale).toBeCloseTo(1.0);
    expect(b.scale).toBeCloseTo(1.0);
    const mid = sampleCamera(spec('static_breath'), 1500, 8000, size);
    expect(Math.abs(mid.scale - 1)).toBeLessThanOrEqual(0.0081);
    expect(mid.scale).toBeGreaterThan(1);
  });

  it('intensity scales zoom amplitude', () => {
    const lo = sampleCamera(spec('ken_burns_in', 0), 8000, 8000, size);
    const hi = sampleCamera(spec('ken_burns_in', 1), 8000, 8000, size);
    expect(hi.scale).toBeGreaterThan(lo.scale);
  });
});
