import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HarnessDriver } from './harness-driver';

const here = dirname(fileURLToPath(import.meta.url));
const sceneA = JSON.parse(
  readFileSync(
    join(here, '../../../../packages/renderer/fixtures/scene-a.json'),
    'utf8',
  ),
);

const book = JSON.stringify({
  id: 'driver-test',
  crossfade_ms: 600,
  pages: [
    { ...sceneA, page_id: 'p1', duration_ms: 1000 },
    { ...sceneA, page_id: 'p2', duration_ms: 1000 },
  ],
});

// 需要本机 chromium + vite；与渲染包 e2e 共享已安装的浏览器
let driver: HarnessDriver;

beforeAll(() => {
  driver = new HarnessDriver();
});

afterAll(async () => {
  await driver.close();
});

describe('HarnessDriver', () => {
  it(
    'creates a session, renders distinct frames and cleans up',
    async () => {
      const page = await driver.acquire();
      try {
        const handle = await driver.createSession(page, book, 10);
        expect(handle.totalFrames).toBe(21); // ceil(2000/100)+1
        const f0 = await driver.renderFrame(page, handle, 0);
        const f10 = await driver.renderFrame(page, handle, 10);
        expect(f0.startsWith('data:image/png;base64,')).toBe(true);
        expect(f0).not.toBe(f10);
        await driver.destroySession(page, handle);
      } finally {
        driver.release(page);
      }
    },
    90_000,
  );

  it('hands out at most maxPages pages concurrently', async () => {
    const small = new HarnessDriver({ maxPages: 2 });
    try {
      const p1 = await small.acquire();
      const p2 = await small.acquire();
      let p3Ready = false;
      const p3Promise = small.acquire().then((p) => {
        p3Ready = true;
        return p;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(p3Ready).toBe(false); // 池满，第三个调用排队等待
      small.release(p1);
      const p3 = await p3Promise;
      expect(p3).toBe(p1); // 归还的 page 直接交给等待者
      small.release(p2);
      small.release(p3);
    } finally {
      await small.close();
    }
  }, 90_000);
});
