import { PNG } from 'pngjs';

/**
 * 生成纯色占位 PNG（如插画生成失败时的温柔底色）。
 * 供服务端在文生图多次重试仍失败时落一张可渲染的兜底图，让管线继续走完，
 * 失败页事后单独重画。
 */
export function encodeSolidPng(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const idx = i << 2;
    png.data[idx] = rgb[0];
    png.data[idx + 1] = rgb[1];
    png.data[idx + 2] = rgb[2];
    png.data[idx + 3] = 255;
  }
  return PNG.sync.write(png);
}
