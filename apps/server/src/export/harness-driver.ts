import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';

export interface SessionHandle {
  sessionId: string;
  totalFrames: number;
  width: number;
  height: number;
}

const DEFAULT_PORT = 5199;
// 用 localhost 而非 127.0.0.1：vite 在本机可能只绑定 IPv6 ::1
const HARNESS_URL = (port: number) => `http://localhost:${port}/`;
// 每个 page 一个 WebGL context，受 CPU/GPU 限制：3 路是常见开发机 1080p 的甜点值
const DEFAULT_PAGES = 3;

interface PbHarness {
  createExportSession(bookJson: string, fps: number): Promise<SessionHandle>;
  renderExportFrame(sessionId: string, frameIndex: number): Promise<string>;
  destroyExportSession(sessionId: string): Promise<void>;
}

/**
 * headless 渲染驱动：browser page 池。
 * 每个 page 持有独立的 PixiJS 实例，可并行渲染多个片段；
 * 调用方 acquire 借走、用完必须 release 归还（池满时排队等待空闲 page）。
 */
export class HarnessDriver {
  private browser?: Browser;
  private boot?: Promise<Browser>;
  private vite?: ChildProcess;
  private readonly port: number;
  private readonly maxPages: number;
  private readonly idle: Page[] = [];
  private readonly waiters: ((page: Page) => void)[] = [];
  private created = 0;

  constructor(opts: { harnessPort?: number; maxPages?: number } = {}) {
    this.port = opts.harnessPort ?? Number(process.env.PB_HARNESS_PORT ?? DEFAULT_PORT);
    this.maxPages = opts.maxPages ?? Number(process.env.PB_HARNESS_PAGES ?? DEFAULT_PAGES);
  }

  /** 借一个空闲 page（没有则新建，池满则排队）；用完必须 release */
  async acquire(): Promise<Page> {
    const free = this.idle.pop();
    if (free) return free;
    if (this.created < this.maxPages) {
      this.created += 1;
      try {
        return await this.newPage();
      } catch (err) {
        this.created -= 1;
        throw err;
      }
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(page: Page): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(page);
    else this.idle.push(page);
  }

  private async waitForHttp(url: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const res = await fetch(url);
        if (res.ok) return;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error(`harness not reachable: ${url}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** 浏览器只启动一次；并发 acquire 共享同一个启动 Promise（失败则重置供下次重试） */
  private browserOnce(): Promise<Browser> {
    this.boot ??= (async () => {
      await this.ensureVite();
      const browser = await chromium.launch();
      this.browser = browser;
      return browser;
    })().catch((err: unknown) => {
      this.boot = undefined;
      throw err;
    });
    return this.boot;
  }

  private async newPage(): Promise<Page> {
    const browser = await this.browserOnce();
    const page = await browser.newPage();
    await page.goto(HARNESS_URL(this.port));
    await page.waitForFunction(() => document.title === 'harness ready', undefined, {
      timeout: 30_000,
    });
    return page;
  }

  private async ensureVite(): Promise<void> {
    try {
      const res = await fetch(HARNESS_URL(this.port));
      if (res.ok) return; // 已有 harness 在跑（例如手工开启的 dev:harness）
    } catch {
      // 需要启动
    }
    const repoRoot = new URL('../../../../', import.meta.url).pathname;
    this.vite = spawn('pnpm', ['--filter', '@pb/renderer', 'dev:harness'], {
      cwd: repoRoot,
      stdio: 'ignore',
      detached: false,
    });
    await this.waitForHttp(HARNESS_URL(this.port), 60_000);
  }

  async createSession(page: Page, bookJson: string, fps: number): Promise<SessionHandle> {
    return page.evaluate(
      async ([b, f]) =>
        (window as unknown as { __pb: PbHarness }).__pb.createExportSession(b, f),
      [bookJson, fps] as const,
    );
  }

  async renderFrame(page: Page, handle: SessionHandle, index: number): Promise<string> {
    return page.evaluate(
      async ([id, i]) =>
        (window as unknown as { __pb: PbHarness }).__pb.renderExportFrame(id, i),
      [handle.sessionId, index] as const,
    );
  }

  async destroySession(page: Page, handle: SessionHandle): Promise<void> {
    await page.evaluate(
      async (id) => (window as unknown as { __pb: PbHarness }).__pb.destroyExportSession(id),
      handle.sessionId,
    );
  }

  async close(): Promise<void> {
    for (const page of this.idle) await page.close().catch(() => undefined);
    this.idle.length = 0;
    this.waiters.length = 0;
    this.created = 0;
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
    this.boot = undefined;
    if (this.vite) {
      this.vite.kill('SIGTERM');
      this.vite = undefined;
    }
  }
}
