import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude],
    coverage: {
      all: true,
      exclude: ['**/*.d.ts', '**/*.config.{js,mjs,ts}', '**/node_modules/**', 'src/bin/**'],
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      thresholds: { branches: 90, functions: 95, lines: 95, statements: 95 },
    },
    passWithNoTests: false,
  },
});
