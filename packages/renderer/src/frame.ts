import type { SceneSpec } from './schema';
import { clamp01 } from './easing';
import { hashSeed } from './rng';
import { sampleCamera, type CameraState } from './presets/camera';
import { sampleSubject, type SubjectState } from './presets/subject';
import {
  createAmbientField,
  sampleAmbient,
  type AmbientState,
  type FieldParticle,
} from './presets/ambient';

export interface FrameState {
  timeMs: number;
  camera: CameraState;
  subjects: SubjectState[];
  ambient: AmbientState[];
  subtitleAlpha: number;
}

const SUBTITLE_FADE_MS = 600;

export class SceneSampler {
  private readonly fields: FieldParticle[][];

  constructor(private readonly spec: SceneSpec) {
    const size = { width: spec.width, height: spec.height };
    this.fields = spec.ambient.map((a) =>
      createAmbientField(a, (spec.seed + hashSeed(a.type)) >>> 0, size),
    );
  }

  sample(tRawMs: number): FrameState {
    const spec = this.spec;
    const size = { width: spec.width, height: spec.height };
    const tMs = Math.min(Math.max(0, tRawMs), spec.duration_ms);

    return {
      timeMs: tMs,
      camera: sampleCamera(spec.camera, tMs, spec.duration_ms, size),
      subjects: spec.subjects.map((s, i) => sampleSubject(s.fx, tMs, i)),
      ambient: spec.ambient.map((a, i) =>
        sampleAmbient(this.fields[i]!, a.type, tMs, size),
      ),
      // 片头叠加层与字幕共用淡入通道（同一时刻只会有其一）
      subtitleAlpha: spec.subtitle || spec.title_overlay ? clamp01(tMs / SUBTITLE_FADE_MS) : 0,
    };
  }
}
