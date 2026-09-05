import type { Lang } from '@pb/ai-core';
import type { AssetStore } from '../asset-store';
import type { BookRepo, ExportArtifact } from '../book-repo';
import type { EventHub } from '../events';
import { transition, type BookEvent } from '../state-machine';

export interface ExportJobDeps {
  repo: BookRepo;
  hub: EventHub;
  exporter: { exportBook(bookId: string, lang: Lang): Promise<ExportArtifact> };
  assets: AssetStore;
}

export class ExportJob {
  constructor(private readonly deps: ExportJobDeps) {}

  private apply(bookId: string, event: BookEvent): void {
    const record = this.deps.repo.get(bookId);
    if (!record) throw new Error(`book not found: ${bookId}`);
    const result = transition(record.state, event, record.counters, { enhance: record.enhance });
    if (!result.ok) throw new Error(result.error);
    this.deps.repo.update({
      ...record,
      state: result.state,
      counters: result.counters,
      updated_at: Date.now(),
    });
    this.deps.hub.publish(bookId, { bookId, type: 'state', state: result.state });
  }

  async run(bookId: string, langs: Lang[]): Promise<void> {
    const record = this.deps.repo.get(bookId);
    if (!record) throw new Error(`book not found: ${bookId}`);
    this.apply(bookId, { type: 'START_EXPORT' });
    const exports: Partial<Record<Lang, ExportArtifact>> = { ...record.exports };
    try {
      for (const lang of langs) {
        exports[lang] = await this.deps.exporter.exportBook(bookId, lang);
        this.deps.repo.update({ ...this.deps.repo.get(bookId)!, exports: { ...exports } });
      }
      this.apply(bookId, { type: 'EXPORT_DONE' });
      this.deps.hub.publish(bookId, { bookId, type: 'completed' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.apply(bookId, { type: 'EXPORT_FAILED', error: message });
      this.deps.repo.update({ ...this.deps.repo.get(bookId)!, error: message });
      this.deps.hub.publish(bookId, { bookId, type: 'failed', error: message });
    }
  }
}
