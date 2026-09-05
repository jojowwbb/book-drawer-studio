import { defineConfig } from '@playwright/test';

// e2e 使用独立端口（8788/5174），避免与开发者手动启动的服务（8787/5173）冲突
export default defineConfig({
  testDir: 'e2e',
  timeout: 300_000,
  use: { baseURL: 'http://localhost:5174' },
  webServer: [
    {
      command: 'pnpm --filter @pb/server start',
      port: 8788,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        PORT: '8788',
        DATA_DIR: 'data-e2e',
        PB_PROVIDERS: 'fake',
        PB_PAGE_SIZE: '320x180',
        PB_EXPORT_FPS: '10',
        PB_DEFAULT_PAGE_COUNT: '3',
        PB_ASSET_ORIGIN: 'http://127.0.0.1:8788',
        // e2e 走完整产线到 ready，不停在音色确认；音色 UI 单独覆盖
        PB_VOICE_REVIEW: 'off',
      },
    },
    {
      command: 'pnpm dev',
      port: 5174,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        WEB_PORT: '5174',
        PB_API_ORIGIN: 'http://127.0.0.1:8788',
      },
    },
  ],
});
