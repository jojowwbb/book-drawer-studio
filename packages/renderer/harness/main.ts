import { Application, Rectangle } from 'pixi.js';
import {
  BookSpecSchema,
  SceneSpecSchema,
  type BookSpec,
  type SceneSpec,
} from '../src/schema';
import { SceneSampler } from '../src/frame';
import { SceneView } from '../src/view/SceneView';
import { renderFrames } from '../src/export/renderFrames';
import { BookPlayer } from '../src/player/BookPlayer';

interface PbHarness {
  renderFrameAt(specJson: string, tMs: number): Promise<string>;
  exportFrameCount(
    specJson: string,
    fps: number,
  ): Promise<{ count: number; firstIsPng: boolean }>;
  playBookAt(
    bookJson: string,
    tMs: number,
  ): Promise<{ pageIndex: number; dataUrl: string }>;
  createExportSession(
    bookJson: string,
    fps: number,
  ): Promise<{ sessionId: string; totalFrames: number; width: number; height: number }>;
  renderExportFrame(sessionId: string, frameIndex: number): Promise<string>;
  destroyExportSession(sessionId: string): Promise<void>;
}

async function initApp(spec: SceneSpec): Promise<Application> {
  const app = new Application();
  await app.init({
    width: spec.width,
    height: spec.height,
    antialias: false,
    background: '#000000',
    preference: 'webgl',
    resolution: 1,
  });
  return app;
}

async function renderFrameAt(specJson: string, tMs: number): Promise<string> {
  const spec: SceneSpec = SceneSpecSchema.parse(JSON.parse(specJson));
  const app = await initApp(spec);
  const view = new SceneView(spec);
  await view.load();
  app.stage.addChild(view.root);

  const sampler = new SceneSampler(spec);
  view.apply(sampler.sample(tMs));
  await app.renderer.render(view.root);

  const canvas = await app.renderer.extract.canvas({
    target: view.root,
    frame: new Rectangle(0, 0, spec.width, spec.height),
  });
  const dataUrl = (canvas as HTMLCanvasElement).toDataURL('image/png');
  view.destroy();
  app.destroy(false);
  return dataUrl;
}

async function exportFrameCount(
  specJson: string,
  fps: number,
): Promise<{ count: number; firstIsPng: boolean }> {
  const spec: SceneSpec = SceneSpecSchema.parse(JSON.parse(specJson));
  const app = await initApp(spec);
  const view = new SceneView(spec);
  await view.load();
  app.stage.addChild(view.root);

  let count = 0;
  let firstIsPng = false;
  for await (const frame of renderFrames(app, view, spec, { fps })) {
    if (count === 0) {
      firstIsPng = frame.blob.type === 'image/png' && frame.blob.size > 500;
    }
    count++;
    if (count >= 10) break;
  }
  view.destroy();
  app.destroy(false);
  return { count, firstIsPng };
}

async function playBookAt(
  bookJson: string,
  tMs: number,
): Promise<{ pageIndex: number; dataUrl: string }> {
  const book = BookSpecSchema.parse(JSON.parse(bookJson));
  const width = book.pages[0]?.width ?? 640;
  const height = book.pages[0]?.height ?? 360;

  // BookPlayer.destroy() loses the WebGL context of its canvas (Pixi v8
  // GlContextSystem.destroy always calls WEBGL_lose_context). Re-initializing
  // Pixi on that same restored canvas deadlocks, so each invocation gets a
  // fresh canvas instead of reusing #stage across calls.
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const player = new BookPlayer(canvas, book);
  await player.init();
  player.seek(tMs);
  const pageIndex = player.pageIndexAt(tMs);

  const app = (player as unknown as { app?: Application }).app;
  if (!app) throw new Error('player not initialized');
  await app.renderer.render(app.stage);
  const out = await app.renderer.extract.canvas({
    target: app.stage,
    frame: new Rectangle(0, 0, width, height),
  });
  const dataUrl = (out as HTMLCanvasElement).toDataURL('image/png');
  player.destroy();
  return { pageIndex, dataUrl };
}

interface ExportSession {
  player: BookPlayer;
  app: Application;
  dt: number;
  totalMs: number;
  width: number;
  height: number;
}

const exportSessions = new Map<string, ExportSession>();

async function createExportSession(
  bookJson: string,
  fps: number,
): Promise<{ sessionId: string; totalFrames: number; width: number; height: number }> {
  const book: BookSpec = BookSpecSchema.parse(JSON.parse(bookJson));
  const first = book.pages[0];
  if (!first) throw new Error('book has no pages');

  let totalMs = 0;
  for (const page of book.pages) totalMs += page.duration_ms;

  // 一会话一 canvas：pixi destroy 后同 canvas 重建会死锁（GlContextSystem）
  const canvas = document.createElement('canvas');
  canvas.width = first.width;
  canvas.height = first.height;

  const player = new BookPlayer(canvas, book);
  await player.init();
  const app = (player as unknown as { app?: Application }).app;
  if (!app) throw new Error('player not initialized');

  const dt = 1000 / fps;
  const sessionId = `exp-${Math.random().toString(36).slice(2)}`;
  exportSessions.set(sessionId, {
    player,
    app,
    dt,
    totalMs,
    width: first.width,
    height: first.height,
  });
  const totalFrames = Math.ceil(totalMs / dt) + 1;
  return { sessionId, totalFrames, width: first.width, height: first.height };
}

async function renderExportFrame(sessionId: string, frameIndex: number): Promise<string> {
  const session = exportSessions.get(sessionId);
  if (!session) throw new Error(`export session not found: ${sessionId}`);
  const tMs = Math.min(frameIndex * session.dt, session.totalMs);
  session.player.renderAt(tMs);
  await session.app.renderer.render(session.app.stage);
  const out = await session.app.renderer.extract.canvas({
    target: session.app.stage,
    frame: new Rectangle(0, 0, session.width, session.height),
  });
  return (out as HTMLCanvasElement).toDataURL('image/png');
}

async function destroyExportSession(sessionId: string): Promise<void> {
  const session = exportSessions.get(sessionId);
  if (!session) return;
  session.player.destroy();
  exportSessions.delete(sessionId);
}

(window as unknown as { __pb: PbHarness }).__pb = {
  renderFrameAt,
  exportFrameCount,
  playBookAt,
  createExportSession,
  renderExportFrame,
  destroyExportSession,
};
document.title = 'harness ready';
