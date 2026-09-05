import type { SubjectFxType } from '../schema';
import { clamp01, easeOutCubic } from '../easing';

export interface SubjectState {
  scale: number;
  rotation: number;
  dx: number;
  dy: number;
  alpha: number;
}

const ENTER_DURATION_MS = 1200;
const ENTER_DISTANCE_PX = 80;

function applyEnter(state: SubjectState, tMs: number, fromDx: number): void {
  if (tMs >= ENTER_DURATION_MS) return;
  const p = easeOutCubic(clamp01(tMs / ENTER_DURATION_MS));
  state.dx += fromDx * (1 - p);
  state.alpha *= p;
}

export function sampleSubject(
  fx: SubjectFxType[],
  tMs: number,
  index: number,
): SubjectState {
  const state: SubjectState = { scale: 1, rotation: 0, dx: 0, dy: 0, alpha: 1 };
  const phase = index * 0.9;

  for (const f of fx) {
    switch (f) {
      case 'breathe':
        state.scale *= 1 + 0.02 * Math.sin((tMs / 3200) * Math.PI * 2 + phase);
        break;
      case 'sway':
        state.rotation +=
          ((1.5 * Math.PI) / 180) * Math.sin((tMs / 4000) * Math.PI * 2 + phase);
        break;
      case 'float':
        state.dy += 4 * Math.sin((tMs / 3600) * Math.PI * 2 + phase);
        break;
      case 'enter_left':
        applyEnter(state, tMs, -ENTER_DISTANCE_PX);
        break;
      case 'enter_right':
        applyEnter(state, tMs, ENTER_DISTANCE_PX);
        break;
    }
  }
  return state;
}
