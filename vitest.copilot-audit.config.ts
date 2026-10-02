import { defineConfig } from 'vitest/config';

// Isolated, synthetic audit. No application server, live account, or model calls.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['audits/copilot/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
