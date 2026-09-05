import { Rectangle, type Application } from 'pixi.js';
import type { FrameState } from '../frame';
import { SceneSampler } from '../frame';
import type { SceneSpec } from '../schema';
import type { SceneView } from '../view/SceneView';

export interface RenderedFrame {
  index: number;
  tMs: number;
  blob: Blob;
}

export interface RenderFramesOptions {
  fps?: number;
  onFrame?: (frame: { index: number; tMs: number; state: FrameState }) => void;
}

/**
 * Yields one PNG frame per fixed 1000/fps ms step, sampling the same
 * SceneSampler the preview player uses (WYSIWYG). Frame count is the
 * fencepost `ceil(duration_ms / dt) + 1`, so the final frame lands exactly
 * at t = duration_ms. Consumers (e.g. the video encoder) MUST derive
 * page/audio boundaries from the actual number of yielded frames, not from
 * duration_ms, to avoid accumulated A/V drift.
 *
 * The caller-built Application must be initialized with `resolution: 1`,
 * `antialias: false`, and `preference: 'webgl'` — pixel-stability
 * determinism (and golden-frame baselines) depend on these options.
 */
export async function* renderFrames(
  app: Application,
  view: SceneView,
  spec: SceneSpec,
  options: RenderFramesOptions = {},
): AsyncGenerator<RenderedFrame> {
  const fps = options.fps ?? 30;
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`renderFrames: fps must be a positive finite number, got ${fps}`);
  }
  const dt = 1000 / fps;
  const sampler = new SceneSampler(spec);
  const total = Math.ceil(spec.duration_ms / dt);

  for (let i = 0; i <= total; i++) {
    const tMs = Math.min(i * dt, spec.duration_ms);
    const state = sampler.sample(tMs);
    view.apply(state);
    options.onFrame?.({ index: i, tMs, state });
    await app.renderer.render(view.root);

    const canvas = await app.renderer.extract.canvas({
      target: view.root,
      frame: new Rectangle(0, 0, spec.width, spec.height),
    });
    const blob = await new Promise<Blob>((resolve, reject) => {
      (canvas as HTMLCanvasElement).toBlob(
        (b) =>
          b
            ? resolve(b)
            : reject(new Error(`canvas.toBlob failed at frame ${i} (t=${tMs}ms)`)),
        'image/png',
      );
    });
    yield { index: i, tMs, blob };
  }
}
