import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lang } from '@pb/ai-core';
import { AssetStore } from '../asset-store';
import { BookRepo, type ExportArtifact } from '../book-repo';
import { EventHub, type HubMessage } from '../events';
import { initialCounters } from '../state-machine';
import { ExportJob } from './export-job';

let dir: string;
let store: AssetStore;
let repo: BookRepo;
let hub: EventHub;
const events: HubMessage[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pb-export-job-'));
  store = new AssetStore(dir);
  repo = new BookRepo(store);
  hub = new EventHub();
  hub.subscribe('b1', (m) => events.push(m));
  events.length = 0;
  repo.create({
    id: 'b1', theme: 't', style: 'watercolor', langs: ['zh', 'en'], enhance: false,
    page_count: 3, state: 'ready', counters: initialCounters(),
    progress: { pages_done: 3, pages_total: 3 }, created_at: 1, updated_at: 1,
  });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const artifact = (lang: Lang): ExportArtifact => ({
  url: `/assets/books/b1/exports/${lang}.mp4`, duration_ms: 5000, size_bytes: 12345,
});

describe('ExportJob', () => {
  it('exports both langs and finishes in completed with artifacts persisted', async () => {
    const exporter = { exportBook: vi.fn(async (_b: string, lang: Lang) => artifact(lang)) };
    const job = new ExportJob({ repo, hub, exporter, assets: store });
    await job.run('b1', ['zh', 'en']);
    const record = repo.get('b1')!;
    expect(record.state).toBe('completed');
    expect(record.exports?.zh).toEqual(artifact('zh'));
    expect(record.exports?.en).toEqual(artifact('en'));
    expect(events.some((e) => e.type === 'state' && e.state === 'exporting')).toBe(true);
    expect(events.some((e) => e.type === 'completed')).toBe(true);
  });

  it('on failure returns to ready with error recorded and emits failed', async () => {
    const exporter = {
      exportBook: vi.fn(async () => {
        throw new Error('renderer crashed');
      }),
    };
    const job = new ExportJob({ repo, hub, exporter, assets: store });
    await job.run('b1', ['zh']);
    const record = repo.get('b1')!;
    expect(record.state).toBe('ready');
    expect(record.error).toContain('renderer crashed');
    expect(events.some((e) => e.type === 'failed')).toBe(true);
  });
});
