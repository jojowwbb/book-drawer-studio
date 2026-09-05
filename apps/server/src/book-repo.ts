import type { Lang, StyleId } from '@pb/ai-core';
import type { BookCounters, BookState } from './state-machine';
import type { AssetStore } from './asset-store';

export interface BookProgress {
  pages_done: number;
  pages_total: number;
}

export interface ExportArtifact {
  url: string;
  duration_ms: number;
  size_bytes: number;
}

export interface BookRecord {
  id: string;
  theme: string;
  style: StyleId;
  /** 用户主动输入的书名：定稿后强制覆盖 story.title 与片头大标题；缺省由 AI 生成 */
  title?: string;
  /** 画幅：landscape=横版16:9（缺省，兼容旧书），portrait=竖版9:16 */
  format?: 'landscape' | 'portrait';
  langs: Lang[];
  enhance: boolean;
  /** 背景音乐开关：false=成片不混 BGM；缺省（true）按全局 PB_BGM 配置 */
  bgm?: boolean;
  /** 指定则严格按该页数；缺省由 AI 按故事节奏自行分幕，故事定稿后回填实际页数 */
  page_count?: number;
  state: BookState;
  counters: BookCounters;
  error?: string;
  last_reject_reason?: string;
  progress: BookProgress;
  exports?: Partial<Record<Lang, ExportArtifact>>;
  created_at: number;
  updated_at: number;
}

export class BookRepo {
  private cache = new Map<string, BookRecord>();

  constructor(private readonly assets: AssetStore) {}

  create(record: BookRecord): BookRecord {
    this.cache.set(record.id, record);
    this.assets.writeBookRecord(record);
    return record;
  }

  get(id: string): BookRecord | undefined {
    const mem = this.cache.get(id);
    if (mem) return mem;
    const disk = this.assets.tryReadBookRecord(id);
    if (disk) this.cache.set(id, disk);
    return disk;
  }

  update(record: BookRecord): void {
    this.cache.set(record.id, record);
    this.assets.writeBookRecord(record);
  }
}
