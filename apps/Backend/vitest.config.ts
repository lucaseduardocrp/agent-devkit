import { randomBytes } from 'node:crypto';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The code has no built-in encryption key, so each test run gets a fresh one.
    env: { INTEGRATION_ENCRYPTION_KEY: randomBytes(32).toString('hex') },
    exclude: [...configDefaults.exclude, 'tests/integration/**', '.e2e-workspaces-*/**'],
    coverage: {
      exclude: [
        '**/*.d.ts',
        '**/*.config.{js,mjs,ts}',
        '**/index.{js,ts}',
        '**/main.{js,ts}',
        '**/generated/**',
        '**/node_modules/**',
        '**/bootstrap/**',
      ],
      include: ['src/**/*.{js,ts}'],
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
