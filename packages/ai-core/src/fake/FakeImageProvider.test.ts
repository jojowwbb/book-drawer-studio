import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { FakeImageProvider, hslToRgb } from './FakeImageProvider';
import { FakeMattingProvider } from './FakeMattingProvider';

describe('hslToRgb', () => {
  it('maps primary hues to expected channels', () => {
    expect(hslToRgb(0, 1, 0.5)).toEqual([255, 0, 0]);
    expect(hslToRgb(120, 1, 0.5)).toEqual([0, 255, 0]);
    expect(hslToRgb(240, 1, 0.5)).toEqual([0, 0, 255]);
  });
});

describe('FakeImageProvider', () => {
  it('produces decodable PNG of requested size, deterministic per seed', async () => {
    const p = new FakeImageProvider();
    const req = { prompt: 'test', style: 'watercolor' as const, width: 64, height: 36, seed: 7 };
    const a = await p.generateImage(req);
    const b = await p.generateImage(req);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
    const png = PNG.sync.read(Buffer.from(a));
    expect(png.width).toBe(64);
    expect(png.height).toBe(36);
  });

  it('differs across seeds', async () => {
    const p = new FakeImageProvider();
    const a = await p.generateImage({ prompt: 'x', style: 'flat', width: 16, height: 16, seed: 1 });
    const b = await p.generateImage({ prompt: 'x', style: 'flat', width: 16, height: 16, seed: 2 });
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).not.toBe(0);
  });
});

describe('FakeMattingProvider', () => {
  it('splits a full image into background + 1-2 subjects, deterministic', async () => {
    const img = await new FakeImageProvider().generateImage({
      prompt: 'x', style: 'watercolor', width: 64, height: 36, seed: 5,
    });
    const m = new FakeMattingProvider();
    const r1 = await m.matte(img, 5);
    const r2 = await m.matte(img, 5);
    expect(Buffer.compare(Buffer.from(r1.background), Buffer.from(img))).toBe(0);
    expect(r1.subjects.length).toBeGreaterThanOrEqual(1);
    expect(r1.subjects.length).toBeLessThanOrEqual(2);
    expect(r1.subjects).toEqual(r2.subjects);
    for (const s of r1.subjects) {
      const png = PNG.sync.read(Buffer.from(s));
      expect(png.width).toBeGreaterThan(0);
      expect(png.height).toBeGreaterThan(0);
    }
  });
});
