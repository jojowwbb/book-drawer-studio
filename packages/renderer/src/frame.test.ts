import { describe, expect, it } from 'vitest';
import { SceneSampler } from './frame';
import { SceneSpecSchema } from './schema';

const spec = SceneSpecSchema.parse({
  page_id: 'p1',
  duration_ms: 8000,
  seed: 42,
  background: { src: 'bg.png' },
  camera: { type: 'ken_burns_in' },
  subjects: [
    { src: 'a.png', x: 800, y: 700, fx: ['breathe'] },
    { src: 'b.png', x: 1200, y: 720, fx: ['float'] },
  ],
  ambient: [{ type: 'stars_twinkle', density: 0.5 }],
  subtitle: { text: 'hello' },
});

describe('SceneSampler', () => {
  it('samples a complete FrameState at any time', () => {
    const sampler = new SceneSampler(spec);
    const frame = sampler.sample(2000);
    expect(frame.timeMs).toBe(2000);
    expect(frame.camera.scale).toBeGreaterThan(1);
    expect(frame.subjects).toHaveLength(2);
    expect(frame.ambient).toHaveLength(1);
    expect(frame.ambient[0]!.type).toBe('stars_twinkle');
  });

  it('is deterministic across instances with the same spec', () => {
    const a = new SceneSampler(spec).sample(3000);
    const b = new SceneSampler(spec).sample(3000);
    expect(a).toEqual(b);
  });

  it('clamps time to page duration', () => {
    const sampler = new SceneSampler(spec);
    expect(sampler.sample(99999).camera).toEqual(sampler.sample(8000).camera);
  });

  it('subtitle fades in over the first 600ms', () => {
    const sampler = new SceneSampler(spec);
    expect(sampler.sample(0).subtitleAlpha).toBeCloseTo(0);
    expect(sampler.sample(300).subtitleAlpha).toBeCloseTo(0.5);
    expect(sampler.sample(600).subtitleAlpha).toBeCloseTo(1);
  });

  it('spec without subtitle reports subtitleAlpha 0', () => {
    const bare = new SceneSampler(SceneSpecSchema.parse({
      page_id: 'p2',
      duration_ms: 4000,
      background: { src: 'bg.png' },
      camera: { type: 'static_breath' },
    }));
    expect(bare.sample(1000).subtitleAlpha).toBe(0);
  });
});
