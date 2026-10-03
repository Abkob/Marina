import { defineConfig } from '@playwright/test';
import { validatePlanningTestUrl } from './audits/planning/databaseFixtures';
const database = validatePlanningTestUrl(process.env.DATABASE_URL_TEST, process.env.PLANNING_TEST_DB);
export default defineConfig({
  testDir: './e2e', testMatch: 'planning-baseline.spec.ts', timeout: 45000, workers: 1, retries: 0,
  reporter: [['list'], ['json', { outputFile: 'tmp/planning-baseline/browser.json' }]],
  use: { baseURL: 'http://127.0.0.1:3100', channel: 'chromium', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'tablet', use: { viewport: { width: 768, height: 1024 }, hasTouch: true } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
    { name: 'small-phone', use: { viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true } },
  ],
  webServer: [
    { command: 'node --import tsx audits/planning/browserServer.ts', url: 'http://127.0.0.1:3001/api/health/live', timeout: 60000, reuseExistingServer: false,
      env: { NODE_ENV: 'test', DATABASE_URL_TEST: database, PLANNING_TEST_DB: '1' } },
    // Test the deployable assets; cold dev-module transforms can consume navigation timeouts.
    // Always build here so a previous dist directory cannot hide a source regression.
    { command: 'node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port 3100 --host 127.0.0.1 --strictPort', url: 'http://127.0.0.1:3100', timeout: 180000, reuseExistingServer: false },
  ],
});
