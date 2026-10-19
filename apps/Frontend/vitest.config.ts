import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      all: true,
      exclude: [
        '**/*.d.ts',
        '**/*.config.{js,mjs,ts}',
        '**/index.{js,ts,tsx}',
        '**/main.{js,ts,tsx}',
        '**/generated/**',
        '**/node_modules/**',
      ],
      include: ['src/**/*.{js,jsx,ts,tsx}'],
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
    passWithNoTests: false,
  },
});
