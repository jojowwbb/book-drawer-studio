import type { CameraType, Size } from '../schema';
import { clamp01, easeInOutSine } from '../easing';

export interface CameraSpec {
  type: CameraType;
  intensity: number;
}

export interface CameraState {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export function sampleCamera(
  camera: CameraSpec,
  tMs: number,
  durationMs: number,
  size: Size,
): CameraState {
  const p = clamp01(durationMs <= 0 ? 1 : tMs / durationMs);
  const e = easeInOutSine(p);
  const amp = 0.04 + camera.intensity * 0.08;
  const panRange = size.width * amp * 0.8;

  switch (camera.type) {
    case 'ken_burns_in':
      return { scale: 1 + amp * e, offsetX: 0, offsetY: 0 };
    case 'ken_burns_out':
      return { scale: 1 + amp * (1 - e), offsetX: 0, offsetY: 0 };
    case 'pan_left':
      return { scale: 1 + amp, offsetX: panRange * (0.5 - e), offsetY: 0 };
    case 'pan_right':
      return { scale: 1 + amp, offsetX: panRange * (e - 0.5), offsetY: 0 };
    case 'static_breath':
      return {
        scale: 1 + 0.008 * Math.sin((tMs / 6000) * Math.PI * 2),
        offsetX: 0,
        offsetY: 0,
      };
  }
}
