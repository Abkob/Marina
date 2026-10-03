import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  environment: 'node', fileParallelism: false, testTimeout: 30_000, hookTimeout: 60_000,
  include: process.env.PLANNING_NEGATIVE_CONTROL === '1'
    ? ['audits/planning/negative-control.fixture.ts'] : ['audits/planning/**/*.test.ts'],
} });
