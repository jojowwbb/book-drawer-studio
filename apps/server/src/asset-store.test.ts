import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Story } from '@pb/ai-core';
import { AssetStore } from './asset-store';
import { BookRepo } from './book-repo';
import { initialCounters } from './state-machine';
import type { BookRecord } from './book-repo';

let dir: string;
let store: AssetStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pb-assets-'));
  store = new AssetStore(dir);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const story: Story = {
  title: 't v1',
  age_hint: '3-6',
  style_anchor: 'anchor',
  lang: 'zh',
  characters: [{ name: '小暖', appearance_desc: 'bear' }],
  pages: Array.from({ length: 3 }, (_, i) => ({
    page_id: `p${i + 1}`,
    page_text: '正文',
    narration: '旁白',
    scene_desc: '场景',
    characters: [],
    emotion: 'calm' as const,
    is_climax: false,
  })),
};

describe('AssetStore', () => {
  it('maps urls under /assets/books/', () => {
    expect(store.url('b1', 'pages/p1/full.png')).toBe('/assets/books/b1/pages/p1/full.png');
  });

  it('round-trips story with schema validation', () => {
    store.writeStory('b1', 'zh', story);
    expect(store.readStory('b1', 'zh').title).toBe('t v1');
    expect(() => store.readStory('b1', 'en')).toThrow(/story not found/);
  });

  it('round-trips page binaries and manifest', () => {
    store.writePageBinary('b1', 'p1', 'full.png', new Uint8Array([1, 2, 3]));
    expect(store.pageUrl('b1', 'p1', 'full.png')).toBe('/assets/books/b1/pages/p1/full.png');
    expect(store.tryReadPageAssets('b1', 'p1')).toBeUndefined();
    store.writePageAssets('b1', 'p1', {
      page_id: 'p1', seed: 9, image_url: '/x', background_url: '/y',
      subject_urls: [], clip_url: '/c.mp4', clip_duration_ms: 5000,
    });
    expect(store.tryReadPageAssets('b1', 'p1')?.seed).toBe(9);
  });
});

describe('BookRepo persistence', () => {
  it('recovers records from disk in a fresh repo', () => {
    const repo = new BookRepo(store);
    const record: BookRecord = {
      id: 'b2', theme: 'theme', style: 'watercolor', langs: ['zh'], enhance: false,
      page_count: 3, state: 'created', counters: initialCounters(),
      progress: { pages_done: 0, pages_total: 3 }, created_at: 1, updated_at: 1,
    };
    repo.create(record);
    const fresh = new BookRepo(store);
    expect(fresh.get('b2')?.theme).toBe('theme');
    repo.update({ ...record, state: 'ready' });
    expect(new BookRepo(store).get('b2')?.state).toBe('ready');
  });
});
