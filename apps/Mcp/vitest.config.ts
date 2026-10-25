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
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
    passWithNoTests: false,
  },
});
