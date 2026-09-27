import { defineConfig } from '@playwright/test';

const e2eDatabaseUrl = process.env.DATABASE_URL_TEST;
if (!e2eDatabaseUrl || !new URL(e2eDatabaseUrl).pathname.toLowerCase().includes('test')) {
  throw new Error('Playwright requires DATABASE_URL_TEST pointing to a database whose name contains "test".');
}

/**
 * Browser E2E against the production frontend + backend.
 *
 * SAFETY: the API server is spawned with DATABASE_URL pointed at marina_test.
 * E2E never touches the live marina database. reuseExistingServer is false so
 * a stale dev server (which WOULD be on the live DB) fails the port check
 * instead of being silently used.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1, // suites share one test database
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3100',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npx tsx server/index.ts',
      port: 3001,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        DATABASE_URL_TEST: e2eDatabaseUrl,
      },
    },
    {
      command: 'npx vite --port 3100 --strictPort',
      port: 3100,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { DISABLE_HMR: 'true' },
    },
  ],
});
