import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: { baseURL: 'http://localhost:5199' },
  webServer: {
    command: 'pnpm dev:harness',
    port: 5199,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
