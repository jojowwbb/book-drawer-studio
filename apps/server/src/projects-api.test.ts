import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createFakeProjectProviders, createFakeProviders, FakeModerationProvider, type ProjectProviders } from '@pb/ai-core';
import { buildApp } from './api';

let dir: string;
let app: FastifyInstance;
let providers: ProjectProviders;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pb-projects-'));
  providers = createFakeProjectProviders();
  app = await buildApp({ voiceReview: false,
    dataDir: dir,
    pageSize: { width: 64, height: 36 },
    providers: createFakeProviders(),
    projectProviders: providers,
    probeDurationMs: async () => 1800,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function waitForState(id: string, states: string[], timeoutMs = 20000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${id}` });
    const body = res.json() as Record<string, unknown>;
    if (states.includes(body.state as string)) return body;
    if (Date.now() > deadline) throw new Error(`timeout: last state=${String(body.state)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function waitForScene(
  target: FastifyInstance,
  id: string,
  sceneId: string,
  predicate: (s: { scene_id: string; clip_url?: string }) => boolean,
  timeoutMs = 20000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await target.inject({ method: 'GET', url: `/api/projects/${id}` });
    const body = res.json() as { scenes: { scene_id: string; clip_url?: string }[] };
    const scene = body.scenes.find((s) => s.scene_id === sceneId);
    if (scene && predicate(scene)) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting scene ${sceneId}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function createProject(payload: Record<string, unknown> = {}): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { source: '一个关于灯塔与告别的中篇故事', ...payload },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { project_id: string }).project_id;
}

describe('POST /api/projects', () => {
  it('rejects invalid body and moderated input', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/projects', payload: { source: '' } });
    expect(bad.statusCode).toBe(400);

    const strict = await buildApp({ voiceReview: false,
      dataDir: dir,
      providers: createFakeProviders(),
      projectProviders: {
        ...createFakeProjectProviders(),
        moderation: new FakeModerationProvider({ rejectTextWhen: (t) => (t.includes('坏词') ? 'blocked' : undefined) }),
      },
    });
    await strict.ready();
    const res = await strict.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { source: '包含坏词的输入' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'input_rejected', reason: 'blocked' });
    await strict.close();
  });

  it('404 for unknown project', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/nope' });
    expect(res.statusCode).toBe(404);
  });
});

describe('character confirmation checkpoint (end to end)', () => {
  it('create → awaiting → select → confirm → storyboard_review', async () => {
    const id = await createProject({ title: '灯塔' });
    const awaiting = (await waitForState(id, ['awaiting_character_confirmation'])) as {
      characters: { id: string; versions: { seed: number; url?: string }[]; selected?: number }[];
      locations: { id: string; versions: { seed: number; url?: string }[]; selected?: number }[];
    };
    expect(awaiting.characters.length).toBeGreaterThanOrEqual(1);
    for (const card of awaiting.characters) {
      const ok = card.versions.find((v) => v.url);
      expect(ok).toBeDefined();
      const sel = await app.inject({
        method: 'PUT',
        url: `/api/projects/${id}/characters/${card.id}/select`,
        payload: { seed: ok!.seed },
      });
      expect(sel.statusCode).toBe(200);
    }
    // 场景墙：每地点同样选定一版
    expect(awaiting.locations.length).toBeGreaterThanOrEqual(1);
    for (const loc of awaiting.locations) {
      const ok = loc.versions.find((v) => v.url);
      expect(ok).toBeDefined();
      const sel = await app.inject({
        method: 'PUT',
        url: `/api/projects/${id}/locations/${loc.id}/select`,
        payload: { seed: ok!.seed },
      });
      expect(sel.statusCode).toBe(200);
    }

    const conf = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/characters/confirm`,
    });
    expect(conf.statusCode).toBe(202);
    expect((conf.json() as { state: string }).state).toBe('storyboard_review');
    // 确认后不再自动跑分镜：清单已建但无产物
    const view = (await app.inject({ method: 'GET', url: `/api/projects/${id}` })).json() as {
      scenes: { clip_url?: string }[];
    };
    expect(view.scenes.length).toBeGreaterThan(0);
    expect(view.scenes.every((s) => !s.clip_url)).toBe(true);
  });

  it('confirm before all characters selected → 409', async () => {
    const id = await createProject();
    await waitForState(id, ['awaiting_character_confirmation']);
    const res = await app.inject({ method: 'POST', url: `/api/projects/${id}/characters/confirm` });
    expect(res.statusCode).toBe(409);
    expect(String((res.json() as { error: string }).error)).toContain('not selected');
  });

  it('confirm with characters selected but locations missing → 409 mentioning locations', async () => {
    const id = await createProject();
    const awaiting = (await waitForState(id, ['awaiting_character_confirmation'])) as {
      characters: { id: string; versions: { seed: number; url?: string }[] }[];
    };
    for (const card of awaiting.characters) {
      const ok = card.versions.find((v) => v.url)!;
      await app.inject({
        method: 'PUT',
        url: `/api/projects/${id}/characters/${card.id}/select`,
        payload: { seed: ok.seed },
      });
    }
    const res = await app.inject({ method: 'POST', url: `/api/projects/${id}/characters/confirm` });
    expect(res.statusCode).toBe(409);
    expect(String((res.json() as { error: string }).error)).toContain('locations not selected');
  });

  it('select outside the checkpoint → 409', async () => {
    const id = await createProject();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/characters/c1/select`,
      payload: { seed: 1 },
    });
    expect(res.statusCode).toBe(409);
    const locRes = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/locations/l1/select`,
      payload: { seed: 1 },
    });
    expect(locRes.statusCode).toBe(409);
  });

  it('regenerate with a new description returns a fresh round of versions', async () => {
    const id = await createProject();
    const body = (await waitForState(id, ['awaiting_character_confirmation'])) as {
      characters: { id: string; appearance: string; versions: unknown[] }[];
    };
    const card = body.characters[0]!;
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/characters/${card.id}/regenerate`,
      payload: { appearance: '银白短发，灰蓝色眼睛，右脸有一道旧疤' },
    });
    expect(res.statusCode).toBe(202);
    const out = res.json() as { remaining: number; characters: { id: string; appearance: string; versions: { url?: string }[] }[] };
    expect(out.remaining).toBe(2);
    const next = out.characters.find((c) => c.id === card.id)!;
    expect(next.appearance).toContain('银白短发');
    expect(next.versions.filter((v) => v.url)).toHaveLength(3);
  });

  it('regenerate rejects moderated descriptions with 400', async () => {
    const strict = await buildApp({ voiceReview: false,
      dataDir: dir,
      providers: createFakeProviders(),
      projectProviders: {
        ...createFakeProjectProviders(),
        moderation: new FakeModerationProvider({ rejectTextWhen: (t) => (t.includes('禁忌') ? 'no' : undefined) }),
      },
    });
    await strict.ready();
    const created = await strict.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { source: '普通主题' },
    });
    const id = (created.json() as { project_id: string }).project_id;
    // 等卡点
    const deadline = Date.now() + 20000;
    for (;;) {
      const st = await strict.inject({ method: 'GET', url: `/api/projects/${id}` });
      if ((st.json() as { state: string }).state === 'awaiting_character_confirmation') break;
      if (Date.now() > deadline) throw new Error('timeout awaiting');
      await new Promise((r) => setTimeout(r, 50));
    }
    const res = await strict.inject({
      method: 'POST',
      url: `/api/projects/${id}/characters/c1/regenerate`,
      payload: { appearance: '禁忌纹身' },
    });
    expect(res.statusCode).toBe(400);
    await strict.close();
  });
});

describe('export & scene regeneration endpoints', () => {
  it('export walks ready → exporting → completed and stores the artifact', async () => {
    let resolveExport: () => void = () => undefined;
    const gate = new Promise<void>((r) => (resolveExport = r));
    const stubApp = await buildApp({ voiceReview: false,
      dataDir: dir,
      pageSize: { width: 64, height: 36 },
      providers: createFakeProviders(),
      projectProviders: createFakeProjectProviders(),
      probeDurationMs: async () => 1800,
      projectExporter: {
        exportProject: async () => {
          await gate;
          return { url: '/assets/projects/x/exports/final.mp4', duration_ms: 12345, size_bytes: 999 };
        },
      },
    });
    await stubApp.ready();
    const deadline = Date.now() + 30000;
    try {
      const created = await stubApp.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { source: '导出链路测试' },
      });
      const id = (created.json() as { project_id: string }).project_id;
      // fake providers：卡点自动 select + confirm，随后逐场手动生成直到 ready
      for (;;) {
        const st = await stubApp.inject({ method: 'GET', url: `/api/projects/${id}` });
        const body = st.json() as {
          state: string;
          characters: { id: string; versions: { seed: number; url?: string }[] }[];
          locations: { id: string; versions: { seed: number; url?: string }[] }[];
          scenes: { scene_id: string; clip_url?: string }[];
        };
        if (body.state === 'ready') break;
        if (body.state.startsWith('failed_')) throw new Error(`pipeline failed: ${body.state}`);
        if (body.state === 'awaiting_character_confirmation') {
          for (const card of body.characters) {
            const ok = card.versions.find((v) => v.url)!;
            await stubApp.inject({
              method: 'PUT',
              url: `/api/projects/${id}/characters/${card.id}/select`,
              payload: { seed: ok.seed },
            });
          }
          for (const loc of body.locations) {
            const ok = loc.versions.find((v) => v.url)!;
            await stubApp.inject({
              method: 'PUT',
              url: `/api/projects/${id}/locations/${loc.id}/select`,
              payload: { seed: ok.seed },
            });
          }
          await stubApp.inject({ method: 'POST', url: `/api/projects/${id}/characters/confirm` });
        }
        if (body.state === 'storyboard_review') {
          // 逐场点击：r2v 参考图直出
          for (const scene of body.scenes) {
            if (!scene.clip_url) {
              await stubApp.inject({
                method: 'POST',
                url: `/api/projects/${id}/scenes/${scene.scene_id}/clip`,
              });
              await waitForScene(stubApp, id, scene.scene_id, (s) => !!s.clip_url);
            }
          }
        }
        if (Date.now() > deadline) throw new Error(`timeout: last state=${body.state}`);
        await new Promise((r) => setTimeout(r, 50));
      }

      const res = await stubApp.inject({ method: 'POST', url: `/api/projects/${id}/export` });
      expect(res.statusCode).toBe(202);
      resolveExport();
      for (;;) {
        const st = await stubApp.inject({ method: 'GET', url: `/api/projects/${id}` });
        const body = st.json() as { state: string; export?: { duration_ms: number } };
        if (body.state === 'completed') {
          expect(body.export?.duration_ms).toBe(12345);
          break;
        }
        if (Date.now() > deadline) throw new Error(`export timeout: ${body.state}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      await stubApp.close();
    }
  }, 60000);

  it('scene regenerate is rejected before the project is ready', async () => {
    const id = await createProject();
    await waitForState(id, ['awaiting_character_confirmation']);
    const early = await app.inject({ method: 'POST', url: `/api/projects/${id}/scenes/s1/regenerate` });
    expect(early.statusCode).toBe(409);
  });
});

describe('SSE /api/projects/:id/events', () => {
  it('streams the checkpoint state over a live connection', async () => {
    const sseApp = await buildApp({ voiceReview: false,
      dataDir: dir,
      pageSize: { width: 64, height: 36 },
      providers: createFakeProviders(),
      projectProviders: createFakeProjectProviders(),
    });
    await sseApp.ready();
    const address = await sseApp.listen({ port: 0, host: '127.0.0.1' });
    try {
      const created = await sseApp.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { source: 'SSE 测试主题' },
      });
      const { project_id } = created.json() as { project_id: string };

      const collected = await new Promise<string[]>((resolve, reject) => {
        const seen: string[] = [];
        const timer = setTimeout(() => reject(new Error(`sse timeout, saw: ${seen.join(',')}`)), 25000);
        http.get(`${address}/api/projects/${project_id}/events`, (res) => {
          expect(res.headers['content-type']).toBe('text/event-stream');
          let buf = '';
          res.on('data', (chunk: Buffer) => {
            buf += chunk.toString('utf8');
            let sep = buf.indexOf('\n\n');
            while (sep >= 0) {
              const rawEvent = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              const dataLine = rawEvent.split('\n').find((l) => l.startsWith('data: '));
              if (dataLine) seen.push(dataLine.slice(6));
              sep = buf.indexOf('\n\n');
            }
            if (seen.some((s) => JSON.parse(s).state === 'awaiting_character_confirmation')) {
              clearTimeout(timer);
              res.destroy();
              resolve(seen);
            }
          });
          res.on('error', () => undefined);
        });
      });

      const types = collected.map((s) => (JSON.parse(s) as { type: string }).type);
      expect(types).toContain('state');
      expect(types).toContain('progress');
    } finally {
      await sseApp.close();
    }
  }, 40000);
});
