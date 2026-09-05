import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sceneA = readFileSync(join(here, '../fixtures/scene-a.json'), 'utf8');

const book = JSON.stringify({
  id: 'book-1',
  crossfade_ms: 600,
  pages: [
    { ...JSON.parse(sceneA), page_id: 'p1', duration_ms: 3000 },
    { ...JSON.parse(sceneA), page_id: 'p2', duration_ms: 3000 },
  ],
});

test('seek resolves correct page index across the book', async ({ page }) => {
  await page.goto('/');
  const first: { pageIndex: number } = await page.evaluate(
    async ([b, t]) => (window as any).__pb.playBookAt(b, t),
    [book, 1000] as const,
  );
  const second: { pageIndex: number } = await page.evaluate(
    async ([b, t]) => (window as any).__pb.playBookAt(b, t),
    [book, 4000] as const,
  );
  expect(first.pageIndex).toBe(0);
  expect(second.pageIndex).toBe(1);
});

test('frames differ across pages', async ({ page }) => {
  await page.goto('/');
  const a: { dataUrl: string } = await page.evaluate(
    async ([b, t]) => (window as any).__pb.playBookAt(b, t),
    [book, 500] as const,
  );
  const b: { dataUrl: string } = await page.evaluate(
    async ([b, t]) => (window as any).__pb.playBookAt(b, t),
    [book, 5000] as const,
  );
  expect(a.dataUrl).not.toBe(b.dataUrl);
});
