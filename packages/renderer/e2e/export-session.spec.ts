import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sceneA = readFileSync(join(here, '../fixtures/scene-a.json'), 'utf8');
const scene = JSON.parse(sceneA);

const book = JSON.stringify({
  id: 'book-export',
  crossfade_ms: 600,
  pages: [
    { ...scene, page_id: 'p1', duration_ms: 2000 },
    { ...scene, page_id: 'p2', duration_ms: 2000 },
  ],
});

test('export session yields fencepost frames with distinct endpoints', async ({ page }) => {
  await page.goto('/');
  const session = await page.evaluate(
    async ([b, fps]) => (window as any).__pb.createExportSession(b, fps),
    [book, 10] as const,
  );
  // totalMs = 4000, dt = 100 → ceil(4000/100)+1 = 41 帧
  expect(session.totalFrames).toBe(41);
  expect(session.width).toBe(scene.width);
  expect(session.height).toBe(scene.height);

  const first = await page.evaluate(
    async ([id, i]) => (window as any).__pb.renderExportFrame(id, i),
    [session.sessionId, 0] as const,
  );
  const mid = await page.evaluate(
    async ([id, i]) => (window as any).__pb.renderExportFrame(id, i),
    [session.sessionId, 20] as const,
  );
  const last = await page.evaluate(
    async ([id, i]) => (window as any).__pb.renderExportFrame(id, i),
    [session.sessionId, 40] as const,
  );
  expect(first.startsWith('data:image/png;base64,')).toBe(true);
  expect(first).not.toBe(mid);
  expect(last).toBe(mid); // 末帧与前一帧同 clamped 到 totalMs

  await page.evaluate(async ([id]) => (window as any).__pb.destroyExportSession(id), [
    session.sessionId,
  ] as const);
});
