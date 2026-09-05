import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SceneSpec } from '@pb/renderer';
import type { AssetStore } from '../asset-store';
import { dataUrlToBytes, pipeFrames } from './ffmpeg';
import type { HarnessDriver } from './harness-driver';

export interface GenerateClipArgs {
  bookId: string;
  pageId: string;
  sceneSpec: SceneSpec;
}

export interface ClipSource {
  readonly name: string;
  generateClip(args: GenerateClipArgs): Promise<{ durationMs: number }>;
}

export function clipPathFor(assets: AssetStore, bookId: string, pageId: string): string {
  return assets.rootPath('books', bookId, 'pages', pageId, 'clip.mp4');
}

/** harness 页面无法解析 /assets 相对 URL，需重写为 API 源的绝对地址。 */
function absolutizeSceneUrls(spec: SceneSpec, origin: string): SceneSpec {
  const prefix = (src: string): string =>
    src.startsWith('/assets/') ? `${origin.replace(/\/$/, '')}${src}` : src;
  return {
    ...spec,
    background: { ...spec.background, src: prefix(spec.background.src) },
    subjects: spec.subjects.map((s) => ({ ...s, src: prefix(s.src) })),
    foreground: spec.foreground ? { ...spec.foreground, src: prefix(spec.foreground.src) } : undefined,
  };
}

/**
 * 片段唯一来源：headless 逐帧渲染单页 BookSpec（真实/演示模式通用）。
 * 插画作为 canvas 纹理，镜头推拉/环境粒子等预设动效产帧，ffmpeg 编码为无声 mp4——
 * 画面 100% 忠实于已生成的插画，不引入图生视频 AI。
 * 每次 generateClip 从 page 池借一个空闲 page，多片段可并行渲染（池满自动排队）。
 */
export class HeadlessClipRenderer implements ClipSource {
  readonly name = 'clip:headless';

  constructor(
    private readonly opts: {
      assets: AssetStore;
      driver: HarnessDriver;
      fps?: number;
      /** API 服务的对外源，用于把资产 URL 重写为绝对地址 */
      assetOrigin?: string;
    },
  ) {}

  async generateClip(args: GenerateClipArgs): Promise<{ durationMs: number }> {
    const fps = this.opts.fps ?? 30;
    const origin = this.opts.assetOrigin ?? 'http://127.0.0.1:8787';
    const bookJson = JSON.stringify({
      id: `${args.bookId}-${args.pageId}`,
      crossfade_ms: 0,
      pages: [absolutizeSceneUrls(args.sceneSpec, origin)],
    });
    const page = await this.opts.driver.acquire();
    try {
      const session = await this.opts.driver.createSession(page, bookJson, fps);
      const path = clipPathFor(this.opts.assets, args.bookId, args.pageId);
      mkdirSync(dirname(path), { recursive: true });
      try {
        await pipeFrames(
          'ffmpeg',
          [
            '-y', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
            '-an', path,
          ],
          async (index) => dataUrlToBytes(await this.opts.driver.renderFrame(page, session, index)),
          session.totalFrames,
        );
      } finally {
        await this.opts.driver.destroySession(page, session);
      }
      return { durationMs: Math.round((session.totalFrames / fps) * 1000) };
    } finally {
      this.opts.driver.release(page);
    }
  }
}
