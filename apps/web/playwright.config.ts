import { defineConfig, devices } from '@playwright/test';

// Phase 15 E2E suite. Talks to the real apps/api dev server (port 3000,
// same DB/Redis as `pnpm dev`) and the real apps/web dev server (port
// 3001), plus a persistent GitHub/Claude mock (e2e/mock-providers.mjs) so
// account-connect/sync/discover/AI/copilot flows exercise real code paths
// without hitting real vendor APIs — same convention every apps/api
// verify:* script already uses, just kept alive for the whole run instead
// of spun up per-script.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'node mock-providers.mjs',
      cwd: './e2e',
      port: 3999,
      reuseExistingServer: false,
      timeout: 10_000,
    },
    {
      command: 'pnpm --filter api dev',
      cwd: '../..',
      url: 'http://localhost:3000/health',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'pnpm dev',
      url: 'http://localhost:3001',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
