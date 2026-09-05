export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export const easeInOutSine = (p: number): number => -(Math.cos(Math.PI * p) - 1) / 2;

export const easeOutCubic = (p: number): number => 1 - Math.pow(1 - p, 3);
