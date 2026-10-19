import { describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from '../src/shared/config.js';

describe('runtime configuration', () => {
  it('provides safe local defaults', () => {
    expect(loadRuntimeConfig({})).toEqual({
      nodeEnv: 'development',
      port: 3000,
      logLevel: 'info',
    });
  });

  it('loads explicitly externalized settings', () => {
    expect(
      loadRuntimeConfig({
        NODE_ENV: 'production',
        PORT: '8080',
        LOG_LEVEL: 'warn',
        DATABASE_PROVIDER: 'postgres',
        DATABASE_URL: 'postgresql://localhost:5432/adk',
      }),
    ).toEqual({
      nodeEnv: 'production',
      port: 8080,
      logLevel: 'warn',
      databaseProvider: 'postgres',
      databaseUrl: 'postgresql://localhost:5432/adk',
    });
  });

  it('fails fast for invalid settings', () => {
    expect(() => loadRuntimeConfig({ PORT: '0' })).toThrow();
    expect(() => loadRuntimeConfig({ DATABASE_URL: 'secret' })).toThrow();
    expect(() =>
      loadRuntimeConfig({ DATABASE_PROVIDER: 'oracle', DATABASE_URL: 'secret' }),
    ).toThrow();
    expect(() =>
      loadRuntimeConfig({ DATABASE_PROVIDER: 'sqlserver', DATABASE_URL: 'secret' }),
    ).toThrow();
    expect(() =>
      loadRuntimeConfig({ DATABASE_PROVIDER: 'postgres', DATABASE_URL: 'secret' }),
    ).toThrow();
  });
});
