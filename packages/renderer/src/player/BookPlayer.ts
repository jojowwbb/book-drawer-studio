import { Application, Container } from 'pixi.js';
import { SceneSampler } from '../frame';
import type { BookSpec, SceneSpec } from '../schema';
import { SceneView } from '../view/SceneView';

interface PageRuntime {
  spec: SceneSpec;
  view: SceneView;
  sampler: SceneSampler;
  startMs: number;
}

export class BookPlayer {
  private app?: Application;
  private pages: PageRuntime[] = [];
  private stage = new Container();
  private timeMs = 0;
  private playing = false;
  private tickerCb?: () => void;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly book: BookSpec,
  ) {}

  get durationMs(): number {
    const last = this.pages[this.pages.length - 1];
    return last ? last.startMs + last.spec.duration_ms : 0;
  }

  get currentTimeMs(): number {
    return this.timeMs;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  async init(): Promise<void> {
    if (this.app) return;
    const first = this.book.pages[0];
    if (!first) throw new Error('book has no pages');
    this.app = new Application();
    await this.app.init({
      width: first.width,
      height: first.height,
      resolution: 1,
      antialias: false,
      background: '#000000',
      canvas: this.canvas,
      preference: 'webgl',
    });
    this.app.stage.addChild(this.stage);

    let startMs = 0;
    for (const spec of this.book.pages) {
      const view = new SceneView(spec);
      await view.load();
      this.pages.push({ spec, view, sampler: new SceneSampler(spec), startMs });
      startMs += spec.duration_ms;
    }
    this.renderAt(0);
  }

  play(): void {
    if (!this.app || this.playing) return;
    this.playing = true;
    this.tickerCb = () => {
      this.timeMs += this.app!.ticker.deltaMS;
      if (this.timeMs >= this.durationMs) {
        this.timeMs = this.durationMs;
        this.pause();
      }
      this.renderAt(this.timeMs);
    };
    this.app.ticker.add(this.tickerCb);
  }

  pause(): void {
    if (!this.app || !this.playing) return;
    this.playing = false;
    if (this.tickerCb) this.app.ticker.remove(this.tickerCb);
  }

  seek(tMs: number): void {
    this.timeMs = Math.min(Math.max(0, tMs), this.durationMs);
    this.renderAt(this.timeMs);
  }

  pageIndexAt(tMs: number): number {
    for (let i = this.pages.length - 1; i >= 0; i--) {
      const page = this.pages[i];
      if (page && tMs >= page.startMs) return i;
    }
    return 0;
  }

  renderAt(tMs: number): void {
    const cf = this.book.crossfade_ms;
    const idx = this.pageIndexAt(tMs);
    const page = this.pages[idx];
    if (!page) return;
    const local = tMs - page.startMs;

    this.stage.removeChildren();
    const prev = this.pages[idx - 1];
    if (prev && cf > 0 && local < cf) {
      const p = local / cf;
      prev.view.apply(prev.sampler.sample(prev.spec.duration_ms));
      prev.view.setAlpha(1 - p);
      page.view.apply(page.sampler.sample(local));
      page.view.setAlpha(p);
      this.stage.addChild(prev.view.root);
      this.stage.addChild(page.view.root);
    } else {
      page.view.apply(page.sampler.sample(local));
      page.view.setAlpha(1);
      this.stage.addChild(page.view.root);
    }
  }

  destroy(): void {
    this.pause();
    for (const p of this.pages) p.view.destroy();
    this.pages = [];
    this.app?.destroy(false);
    this.app = undefined;
  }
}
