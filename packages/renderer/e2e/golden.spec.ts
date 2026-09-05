import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const here = dirname(fileURLToPath(import.meta.url));
const sceneA = readFileSync(join(here, '../fixtures/scene-a.json'), 'utf8');
const baselineDir = join(here, 'baseline');
const SAMPLE_TIMES = [0, 1500, 4000, 7200];
const MAX_DIFF_RATIO = 0.002;

test('golden frames match baseline (deterministic rendering)', async ({ page }) => {
  await page.goto('/');
  for (const t of SAMPLE_TIMES) {
    const dataUrl: string = await page.evaluate(
      async ([spec, time]) => (window as any).__pb.renderFrameAt(spec, time),
      [sceneA, t] as const,
    );
    const png = PNG.sync.read(Buffer.from(dataUrl.split(',')[1]!, 'base64'));
    const baselinePath = join(baselineDir, `frame-${t}.png`);

    if (!existsSync(baselinePath)) {
      mkdirSync(baselineDir, { recursive: true });
      writeFileSync(baselinePath, PNG.sync.write(png));
      continue;
    }

    const baseline = PNG.sync.read(readFileSync(baselinePath));
    expect(png.width).toBe(baseline.width);
    expect(png.height).toBe(baseline.height);
    const diff = pixelmatch(png.data, baseline.data, null, png.width, png.height, {
      threshold: 0.1,
    });
    expect(diff).toBeLessThan(png.width * png.height * MAX_DIFF_RATIO);
  }
});
