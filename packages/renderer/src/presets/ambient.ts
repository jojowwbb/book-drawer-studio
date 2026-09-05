import type { AmbientSpec, AmbientType, Size } from '../schema';
import { mulberry32 } from '../rng';

export interface FieldParticle {
  x0: number;
  y0: number;
  size: number;
  phase: number;
  speed: number;
}

export interface AmbientItem {
  x: number;
  y: number;
  alpha: number;
  size: number;
}

export interface AmbientState {
  type: AmbientType;
  items: AmbientItem[];
}

const BASE_COUNT: Record<AmbientType, number> = {
  stars_twinkle: 80,
  clouds_drift: 5,
  fireflies: 30,
  snow: 90,
  rain: 110,
  light_rays: 1,
};

export function createAmbientField(
  spec: AmbientSpec,
  seed: number,
  size: Size,
): FieldParticle[] {
  void size;
  if (spec.type === 'light_rays') {
    return [{ x0: 0.5, y0: 0.5, size: 1, phase: 0, speed: 0 }];
  }
  const rng = mulberry32(seed);
  const count = Math.max(1, Math.round(BASE_COUNT[spec.type] * (0.3 + spec.density)));
  const particles: FieldParticle[] = [];
  for (let i = 0; i < count; i++) {
    const x0 = rng();
    let y0 = rng();
    if (spec.type === 'stars_twinkle') y0 *= 0.6;
    if (spec.type === 'fireflies') y0 = 0.5 + y0 * 0.45;
    particles.push({
      x0,
      y0,
      size: 0.5 + rng(),
      phase: rng() * Math.PI * 2,
      speed: 0.6 + rng() * 0.8,
    });
  }
  return particles;
}

export function sampleAmbient(
  field: FieldParticle[],
  type: AmbientType,
  tMs: number,
  size: Size,
): AmbientState {
  const t = tMs / 1000;
  const items: AmbientItem[] = field.map((p) => {
    switch (type) {
      case 'stars_twinkle': {
        const period = 2 + (p.phase % 1);
        const tw = Math.sin((Math.PI * t) / period + p.phase) ** 2;
        return {
          x: p.x0 * size.width,
          y: p.y0 * size.height,
          alpha: 0.35 + 0.65 * tw,
          size: p.size * 2.5,
        };
      }
      case 'clouds_drift': {
        const x = ((p.x0 + t * p.speed * 0.008) % 1.4) - 0.2;
        return {
          x: x * size.width,
          y: (0.08 + p.y0 * 0.3) * size.height,
          alpha: 0.22,
          size: (120 + p.size * 160) * (size.width / 1920),
        };
      }
      case 'fireflies': {
        const x = p.x0 + 0.02 * Math.sin((2 * Math.PI * t) / 7 + p.phase);
        const y = p.y0 + 0.015 * Math.cos((2 * Math.PI * t) / 9 + p.phase * 1.3);
        const pulse = Math.sin((Math.PI * t) / 2.5 + p.phase) ** 2;
        return {
          x: x * size.width,
          y: y * size.height,
          alpha: 0.25 + 0.75 * pulse,
          size: p.size * 3,
        };
      }
      case 'snow': {
        const y = (p.y0 + t * p.speed * 0.045) % 1.02;
        const x = p.x0 + 0.012 * Math.sin((2 * Math.PI * t) / 5 + p.phase);
        return {
          x: x * size.width,
          y: y * size.height - 10,
          alpha: 0.8,
          size: p.size * 3.5,
        };
      }
      case 'rain': {
        const y = (p.y0 + t * p.speed * 0.55) % 1.02;
        return {
          x: p.x0 * size.width,
          y: y * size.height - 10,
          alpha: 0.45,
          size: p.size * 14,
        };
      }
      case 'light_rays': {
        return {
          x: size.width / 2,
          y: size.height / 2,
          alpha: 0.05 + 0.04 * Math.sin((2 * Math.PI * t) / 8),
          size: 1,
        };
      }
    }
  });
  return { type, items };
}
