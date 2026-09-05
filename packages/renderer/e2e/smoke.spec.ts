import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sceneA = readFileSync(join(here, '../fixtures/scene-a.json'), 'utf8');

function pngSize(dataUrl: string): { w: number; h: number } {
  const buf = Buffer.from(dataUrl.split(',')[1]!, 'base64');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

test('harness renders a frame without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page).toHaveTitle('harness ready');

  const dataUrl: string = await page.evaluate(
    async ([spec, t]) => (window as any).__pb.renderFrameAt(spec, t),
    [sceneA, 2000] as const,
  );

  expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  expect(dataUrl.length).toBeGreaterThan(2000);
  expect(pngSize(dataUrl)).toEqual({ w: 640, h: 360 });
  expect(errors).toEqual([]);
});

test('frames at different times differ (animation is alive)', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('harness ready');
  const a: string = await page.evaluate(
    async ([spec, t]) => (window as any).__pb.renderFrameAt(spec, t),
    [sceneA, 1000] as const,
  );
  const b: string = await page.evaluate(
    async ([spec, t]) => (window as any).__pb.renderFrameAt(spec, t),
    [sceneA, 5000] as const,
  );
  expect(a).not.toBe(b);
});

test('same frame rendered twice is identical (determinism)', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('harness ready');
  const a: string = await page.evaluate(
    async ([spec, t]) => (window as any).__pb.renderFrameAt(spec, t),
    [sceneA, 2000] as const,
  );
  const b: string = await page.evaluate(
    async ([spec, t]) => (window as any).__pb.renderFrameAt(spec, t),
    [sceneA, 2000] as const,
  );
  expect(a).toBe(b);
});
