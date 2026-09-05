import { PNG } from 'pngjs';
import type { ImageProvider, ImageRequest } from '../types';
import { mulberry32 } from './rng';

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [
    Math.round((rgb[0] + m) * 255),
    Math.round((rgb[1] + m) * 255),
    Math.round((rgb[2] + m) * 255),
  ];
}

export class FakeImageProvider implements ImageProvider {
  readonly name = 'fake-image';

  async generateImage(req: ImageRequest): Promise<Uint8Array> {
    const rnd = mulberry32(req.seed);
    const hueA = Math.floor(rnd() * 360);
    const hueB = (hueA + 60) % 360;
    const top = hslToRgb(hueA, 0.45, 0.82);
    const bottom = hslToRgb(hueB, 0.5, 0.55);

    const png = new PNG({ width: req.width, height: req.height });
    for (let y = 0; y < req.height; y++) {
      const t = y / Math.max(1, req.height - 1);
      const r = Math.round(top[0] + (bottom[0] - top[0]) * t);
      const g = Math.round(top[1] + (bottom[1] - top[1]) * t);
      const b = Math.round(top[2] + (bottom[2] - top[2]) * t);
      for (let x = 0; x < req.width; x++) {
        const idx = (req.width * y + x) << 2;
        png.data[idx] = r;
        png.data[idx + 1] = g;
        png.data[idx + 2] = b;
        png.data[idx + 3] = 255;
      }
    }

    const cx = req.width / 2;
    const cy = req.height * 0.62;
    const rx = req.width * 0.18;
    const ry = req.height * 0.22;
    const blob = hslToRgb((hueA + 180) % 360, 0.55, 0.65);
    for (let y = 0; y < req.height; y++) {
      for (let x = 0; x < req.width; x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) {
          const idx = (req.width * y + x) << 2;
          png.data[idx] = blob[0];
          png.data[idx + 1] = blob[1];
          png.data[idx + 2] = blob[2];
        }
      }
    }
    return PNG.sync.write(png);
  }
}
