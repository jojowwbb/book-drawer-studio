import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRepoEnvFile } from './env-file';

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.PB_TEST_ENV_FILE_VAR;
});

function makeWorkspace(files: Record<string, string>): { root: string; scriptUrl: string } {
  const root = mkdtempSync(join(tmpdir(), 'pb-envfile-'));
  created.push(root);
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  // 模拟深层的脚本文件位置
  const scriptDir = join(root, 'packages/x/src/deep');
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(join(scriptDir, 'probe.mjs'), '');
  return { root, scriptUrl: `file://${join(scriptDir, 'probe.mjs')}` };
}

describe('loadRepoEnvFile', () => {
  it('walks up to the workspace root and loads .env without overriding existing env', () => {
    const { scriptUrl } = makeWorkspace({
      '.env': 'PB_TEST_ENV_FILE_VAR=from-file\n',
    });
    process.env.PB_TEST_ENV_FILE_VAR = 'from-shell';
    loadRepoEnvFile(scriptUrl);
    expect(process.env.PB_TEST_ENV_FILE_VAR).toBe('from-shell'); // 环境变量优先
    delete process.env.PB_TEST_ENV_FILE_VAR;
    loadRepoEnvFile(scriptUrl);
    expect(process.env.PB_TEST_ENV_FILE_VAR).toBe('from-file'); // 无环境变量时来自文件
  });

  it('does nothing when no .env exists up to the workspace root', () => {
    const { scriptUrl } = makeWorkspace({});
    expect(() => loadRepoEnvFile(scriptUrl)).not.toThrow();
    expect(process.env.PB_TEST_ENV_FILE_VAR).toBeUndefined();
  });
});
