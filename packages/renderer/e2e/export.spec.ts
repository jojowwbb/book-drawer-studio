import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sceneA = readFileSync(join(here, '../fixtures/scene-a.json'), 'utf8');

test('renderFrames yields sequential PNG frames at fixed step', async ({ page }) => {
  await page.goto('/');
  const result: { count: number; firstIsPng: boolean } = await page.evaluate(
    async ([spec, fps]) => (window as any).__pb.exportFrameCount(spec, fps),
    [sceneA, 30] as const,
  );
  expect(result.count).toBe(10);
  expect(result.firstIsPng).toBe(true);
});
