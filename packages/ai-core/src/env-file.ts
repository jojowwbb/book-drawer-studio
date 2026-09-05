import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 从调用方位置向上找到仓库根（以 pnpm-workspace.yaml 为界），加载沿途第一个 .env。
 * 已存在的环境变量优先于文件值（Node loadEnvFile 语义）；没有 .env 时静默跳过。
 */
export function loadRepoEnvFile(importMetaUrl: string): void {
  let dir = dirname(fileURLToPath(importMetaUrl));
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return;
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
