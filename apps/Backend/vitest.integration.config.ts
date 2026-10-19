import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.integration.test.ts'],
    fileParallelism: false,
    passWithNoTests: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
