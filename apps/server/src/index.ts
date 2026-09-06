import { resolve } from 'node:path';
import { createFakeProviders, loadRepoEnvFile, type ProviderBundle } from '@pb/ai-core';
import { buildApp } from './api';
import { TRANSITION_TYPES, type TransitionType } from './export/clip-join';

// 优先读取仓库根 .env（已存在的 shell 环境变量仍然优先）
loadRepoEnvFile(import.meta.url);

function parseTransition(raw: string | undefined): TransitionType | undefined {
  if (!raw) return undefined;
  if (!(TRANSITION_TYPES as readonly string[]).includes(raw)) {
    throw new Error(`invalid PB_EXPORT_TRANSITION: ${raw} (取 ${TRANSITION_TYPES.join('/')})`);
  }
  return raw as TransitionType;
}

const port = Number(process.env.PORT ?? 8787);
const dataDir = resolve(process.env.DATA_DIR ?? resolve(process.cwd(), 'data'));

function parsePageSize(raw: string | undefined): { width: number; height: number } | undefined {
  if (!raw) return undefined;
  const m = /^(\d+)x(\d+)$/.exec(raw);
  if (!m) throw new Error(`invalid PB_PAGE_SIZE: ${raw}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

// 演示模式已移除：产品始终使用真实供应商（缺 key 启动即抛 MissingEnvError）。
// PB_PROVIDERS=fake 仅供 Playwright e2e 测试注入确定性桩，不面向任何真实使用场景。
function providersForE2E(): ProviderBundle | undefined {
  if (process.env.PB_PROVIDERS !== 'fake') return undefined;
  console.warn('[warning] PB_PROVIDERS=fake 是 e2e 测试专用开关，产品不提供演示模式');
  return createFakeProviders();
}

const app = await buildApp({
  dataDir,
  pageSize: parsePageSize(process.env.PB_PAGE_SIZE),
  exportFps: process.env.PB_EXPORT_FPS ? Number(process.env.PB_EXPORT_FPS) : undefined,
  exportTransitionMs: process.env.PB_EXPORT_TRANSITION_MS
    ? Number(process.env.PB_EXPORT_TRANSITION_MS)
    : undefined,
  // PB_EXPORT_TRANSITION=fade|slideleft|coverleft|wipeleft（缺省 slideleft 翻页感）
  exportTransition: parseTransition(process.env.PB_EXPORT_TRANSITION),
  bgm: process.env.PB_BGM,
  sfx: process.env.PB_SFX,
  defaultPageCount: process.env.PB_DEFAULT_PAGE_COUNT
    ? Number(process.env.PB_DEFAULT_PAGE_COUNT)
    : undefined,
  assetOrigin: process.env.PB_ASSET_ORIGIN ?? `http://127.0.0.1:${port}`,
  providers: providersForE2E(),
  // PB_VOICE_REVIEW=off：跳过音色确认暂停（批量产线/自动化）；缺省开启
  voiceReview: process.env.PB_VOICE_REVIEW !== 'off',
});
await app.listen({ port, host: '0.0.0.0' });
console.log(`picturebook server listening on :${port} (data: ${dataDir})`);
