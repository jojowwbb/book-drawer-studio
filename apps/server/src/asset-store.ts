import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Lang } from '@pb/ai-core';
import { ScriptAnalysisSchema, StorySchema, type ScriptAnalysis, type Story } from '@pb/ai-core';
import type { BookSpec } from '@pb/renderer';
import type { BookRecord } from './book-repo';
import type { PageAssets } from './page-assets';
import type { ScriptProjectRecord } from './project-repo';

export class AssetStore {
  constructor(private readonly rootDir: string) {}

  get root(): string {
    return this.rootDir;
  }

  rootPath(...segments: string[]): string {
    return join(this.rootDir, ...segments);
  }

  private bookDir(bookId: string): string {
    return join(this.rootDir, 'books', bookId);
  }

  private write(path: string, data: Uint8Array | string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  }

  private tryRead(path: string): Buffer | undefined {
    if (!existsSync(path)) return undefined;
    return readFileSync(path);
  }

  url(bookId: string, relPath: string): string {
    return `/assets/books/${bookId}/${relPath}`;
  }

  writeBookRecord(record: BookRecord): void {
    this.write(join(this.bookDir(record.id), 'book.json'), JSON.stringify(record, null, 2));
  }

  tryReadBookRecord(bookId: string): BookRecord | undefined {
    const raw = this.tryRead(join(this.bookDir(bookId), 'book.json'));
    return raw ? (JSON.parse(raw.toString('utf8')) as BookRecord) : undefined;
  }

  writeStory(bookId: string, lang: Lang, story: Story): void {
    this.write(join(this.bookDir(bookId), `story.${lang}.json`), JSON.stringify(story, null, 2));
  }

  readStory(bookId: string, lang: Lang): Story {
    const raw = this.tryRead(join(this.bookDir(bookId), `story.${lang}.json`));
    if (!raw) throw new Error(`story not found: ${bookId} ${lang}`);
    return StorySchema.parse(JSON.parse(raw.toString('utf8')));
  }

  writePageBinary(bookId: string, pageId: string, relPath: string, bytes: Uint8Array): void {
    this.write(join(this.bookDir(bookId), 'pages', pageId, relPath), bytes);
  }

  pageUrl(bookId: string, pageId: string, relPath: string): string {
    return this.url(bookId, `pages/${pageId}/${relPath}`);
  }

  writePageAssets(bookId: string, pageId: string, manifest: PageAssets): void {
    this.write(
      join(this.bookDir(bookId), 'pages', pageId, 'assets.json'),
      JSON.stringify(manifest, null, 2),
    );
  }

  tryReadPageAssets(bookId: string, pageId: string): PageAssets | undefined {
    const raw = this.tryRead(join(this.bookDir(bookId), 'pages', pageId, 'assets.json'));
    return raw ? (JSON.parse(raw.toString('utf8')) as PageAssets) : undefined;
  }

  writeBookSpec(bookId: string, lang: Lang, spec: BookSpec): void {
    this.write(join(this.bookDir(bookId), 'book_specs', `${lang}.json`), JSON.stringify(spec, null, 2));
  }

  bookSpecUrl(bookId: string, lang: Lang): string {
    return this.url(bookId, `book_specs/${lang}.json`);
  }

  exportUrl(bookId: string, lang: Lang): string {
    return this.url(bookId, `exports/${lang}.mp4`);
  }

  // ---------- 故事视频产线（projects/<id>/） ----------

  private projectDir(projectId: string): string {
    return join(this.rootDir, 'projects', projectId);
  }

  projectUrl(projectId: string, relPath: string): string {
    return `/assets/projects/${projectId}/${relPath}`;
  }

  writeProjectRecord(record: ScriptProjectRecord): void {
    this.write(join(this.projectDir(record.id), 'project.json'), JSON.stringify(record, null, 2));
  }

  tryReadProjectRecord(projectId: string): ScriptProjectRecord | undefined {
    const raw = this.tryRead(join(this.projectDir(projectId), 'project.json'));
    return raw ? (JSON.parse(raw.toString('utf8')) as ScriptProjectRecord) : undefined;
  }

  writeScript(projectId: string, script: ScriptAnalysis): void {
    this.write(join(this.projectDir(projectId), 'script.json'), JSON.stringify(script, null, 2));
  }

  readScript(projectId: string): ScriptAnalysis {
    const raw = this.tryRead(join(this.projectDir(projectId), 'script.json'));
    if (!raw) throw new Error(`script not found: ${projectId}`);
    return ScriptAnalysisSchema.parse(JSON.parse(raw.toString('utf8')));
  }

  tryReadScript(projectId: string): ScriptAnalysis | undefined {
    const raw = this.tryRead(join(this.projectDir(projectId), 'script.json'));
    return raw ? ScriptAnalysisSchema.parse(JSON.parse(raw.toString('utf8'))) : undefined;
  }

  /** 角色立绘等二进制资产：characters/<charId>/<relPath> */
  writeCharacterBinary(projectId: string, charId: string, relPath: string, bytes: Uint8Array): void {
    this.write(join(this.projectDir(projectId), 'characters', charId, relPath), bytes);
  }

  characterUrl(projectId: string, charId: string, relPath: string): string {
    return this.projectUrl(projectId, `characters/${charId}/${relPath}`);
  }

  /** 场景图等二进制资产：locations/<locId>/<relPath> */
  writeLocationBinary(projectId: string, locId: string, relPath: string, bytes: Uint8Array): void {
    this.write(join(this.projectDir(projectId), 'locations', locId, relPath), bytes);
  }

  locationUrl(projectId: string, locId: string, relPath: string): string {
    return this.projectUrl(projectId, `locations/${locId}/${relPath}`);
  }

  /** 场次资产（片段/配音）：scenes/<sceneId>/<relPath> */
  writeSceneBinary(projectId: string, sceneId: string, relPath: string, bytes: Uint8Array): void {
    this.write(join(this.projectDir(projectId), 'scenes', sceneId, relPath), bytes);
  }

  sceneUrl(projectId: string, sceneId: string, relPath: string): string {
    return this.projectUrl(projectId, `scenes/${sceneId}/${relPath}`);
  }

  projectExportUrl(projectId: string): string {
    return this.projectUrl(projectId, 'exports/final.mp4');
  }
}
