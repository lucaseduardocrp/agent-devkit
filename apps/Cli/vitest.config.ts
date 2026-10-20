import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // Tests run against the MCP sources, so they do not need a build of apps/Mcp.
  resolve: {
    alias: {
      '#mcp': fileURLToPath(new URL('../Mcp/src/index.ts', import.meta.url)),
    },
  },
  test: {
    exclude: [...configDefaults.exclude],
    coverage: {
      all: true,
      // src/vendor holds the backend's Playwright runner, covered by the backend's own tests.
      exclude: [
        '**/*.d.ts',
        '**/*.config.{js,mjs,ts}',
        '**/node_modules/**',
        'src/bin/**',
        'src/vendor/**',
      ],
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      thresholds: { branches: 90, functions: 95, lines: 95, statements: 95 },
    },
    passWithNoTests: false,
  },
});
