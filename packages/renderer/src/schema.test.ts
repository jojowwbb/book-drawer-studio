import { describe, expect, it } from 'vitest';
import {
  AMBIENT_TYPES,
  BookSpecSchema,
  CAMERA_TYPES,
  SceneSpecSchema,
  SUBJECT_FX_TYPES,
} from './schema';

const minimal = {
  page_id: 'p1',
  duration_ms: 8000,
  background: { src: 'bg.png' },
  camera: { type: 'ken_burns_in' },
};

describe('SceneSpecSchema', () => {
  it('parses minimal spec and applies defaults', () => {
    const spec = SceneSpecSchema.parse(minimal);
    expect(spec.width).toBe(1920);
    expect(spec.height).toBe(1080);
    expect(spec.seed).toBe(0);
    expect(spec.subjects).toEqual([]);
    expect(spec.ambient).toEqual([]);
    expect(spec.camera.intensity).toBe(0.5);
    expect(spec.base_color).toBe('#101828');
  });

  it('rejects unknown camera type', () => {
    expect(() =>
      SceneSpecSchema.parse({ ...minimal, camera: { type: 'zoom_wild' } }),
    ).toThrow();
  });

  it('rejects non-positive duration', () => {
    expect(() => SceneSpecSchema.parse({ ...minimal, duration_ms: 0 })).toThrow();
  });

  it('accepts full spec with subjects, ambient, subtitle, video_ref', () => {
    const spec = SceneSpecSchema.parse({
      ...minimal,
      seed: 42,
      subjects: [{ src: 's.png', x: 960, y: 700, scale: 1.2, fx: ['breathe', 'sway'] }],
      ambient: [{ type: 'stars_twinkle', density: 0.7 }],
      foreground: { src: 'fg.png' },
      subtitle: { text: 'hello' },
      video_ref: 'climax.mp4',
      audio_refs: { narration: 'n.mp3', bgm: 'b.mp3' },
    });
    expect(spec.subjects[0]!.fx).toEqual(['breathe', 'sway']);
    expect(spec.ambient[0]!.density).toBe(0.7);
  });
});

describe('BookSpecSchema', () => {
  it('parses book with pages and default crossfade', () => {
    const book = BookSpecSchema.parse({ id: 'b1', pages: [minimal] });
    expect(book.crossfade_ms).toBe(600);
  });

  it('requires at least one page', () => {
    expect(() => BookSpecSchema.parse({ id: 'b1', pages: [] })).toThrow();
  });
});

describe('preset enums', () => {
  it('exposes 5 camera / 5 subject / 6 ambient presets', () => {
    expect(CAMERA_TYPES).toHaveLength(5);
    expect(SUBJECT_FX_TYPES).toHaveLength(5);
    expect(AMBIENT_TYPES).toHaveLength(6);
  });
});
