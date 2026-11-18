import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      all: true,
      // Electron glue that needs a running app: covered by launching it, not by unit tests.
      exclude: [
        '**/*.d.ts',
        '**/*.config.{js,mjs,ts}',
        '**/node_modules/**',
        'src/main/index.ts',
        'src/main/development-ipc.ts',
        'src/main/postgres.ts',
        'src/main/services.ts',
        'src/main/app-protocol.ts',
        'src/main/updates.ts',
        'src/preload/**',
        // The CLI's Development runner, covered by the CLI's own tests (tests/*-parity).
        'src/vendor/**',
      ],
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json', 'lcov'],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
  },
});
