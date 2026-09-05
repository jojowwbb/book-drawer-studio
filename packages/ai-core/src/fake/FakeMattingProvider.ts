import { PNG } from 'pngjs';
import type { MattingProvider, MatteResult } from '../types';
import { mulberry32, hashSeed } from './rng';
import { hslToRgb } from './FakeImageProvider';

function solidBlob(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - width / 2) / (width / 2);
      const dy = (y - height / 2) / (height / 2);
      const idx = (width * y + x) << 2;
      const inside = dx * dx + dy * dy <= 1;
      png.data[idx] = rgb[0];
      png.data[idx + 1] = rgb[1];
      png.data[idx + 2] = rgb[2];
      png.data[idx + 3] = inside ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

export class FakeMattingProvider implements MattingProvider {
  readonly name = 'fake-matting';

  async matte(fullImagePng: Uint8Array, seed: number): Promise<MatteResult> {
    const full = PNG.sync.read(Buffer.from(fullImagePng));
    const rnd = mulberry32((seed ^ hashSeed('matte')) >>> 0);
    const subjectCount = 1 + Math.floor(rnd() * 2);
    const subjects: Uint8Array[] = [];
    for (let i = 0; i < subjectCount; i++) {
      const w = Math.max(8, Math.round(full.width * 0.3));
      const h = Math.max(8, Math.round(full.height * 0.4));
      const rgb = hslToRgb(Math.floor(rnd() * 360), 0.6, 0.55);
      subjects.push(solidBlob(w, h, rgb));
    }
    const result: MatteResult = { background: fullImagePng, subjects };
    if (rnd() < 0.25) {
      result.foreground = solidBlob(
        Math.max(8, Math.round(full.width * 0.8)),
        Math.max(8, Math.round(full.height * 0.2)),
        hslToRgb(Math.floor(rnd() * 360), 0.4, 0.35),
      );
    }
    return result;
  }
}
