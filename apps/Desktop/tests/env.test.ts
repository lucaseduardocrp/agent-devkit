import {
  APP_ORIGIN,
  apiUrl,
  backendEnvironment,
  databaseUrl,
  mcpEnvironment,
  mcpUrl,
} from '../src/main/env.js';
import type { DesktopSettings } from '../src/main/settings.js';

const settings: DesktopSettings = {
  apiPort: 3001,
  mcpPort: 3334,
  databasePort: 54330,
  integrationEncryptionKey: 'k'.repeat(64),
  oauthStateSecret: 'o'.repeat(64),
  mcpOauthSecret: 'm'.repeat(64),
  databasePassword: 'p@ss/word',
};

describe('desktop environment', () => {
  it('builds addresses on this computer', () => {
    expect(apiUrl(settings)).toBe('http://127.0.0.1:3001');
    expect(mcpUrl(settings)).toBe('http://localhost:3334/mcp');
    expect(databaseUrl(settings)).toBe('postgresql://adk:p%40ss%2Fword@127.0.0.1:54330/adk');
  });

  it('runs the API on loopback only, without Redis or a separate worker', () => {
    const env = backendEnvironment(settings, { browsersPath: '/b', dataDir: '/d' });
    expect(env).toMatchObject({
      HOST: '127.0.0.1',
      PORT: '3001',
      DATABASE_PROVIDER: 'postgres',
      FRONTEND_URL: APP_ORIGIN,
      PLAYWRIGHT_BROWSERS_PATH: '/b',
      INTEGRATION_ENCRYPTION_KEY: 'k'.repeat(64),
      ADK_HOST_ACCESS: 'true',
      ADK_HOST_ALIAS: 'localhost',
    });
    expect(env).not.toHaveProperty('REDIS_URL');
    expect(env).not.toHaveProperty('E2E_WORKER_URL');
  });

  it('sends OAuth back to the dev server in live mode', () => {
    const env = backendEnvironment(settings, {
      browsersPath: '/b',
      dataDir: '/d',
      frontendUrl: 'http://localhost:5173',
    });
    expect(env['FRONTEND_URL']).toBe('http://localhost:5173');
  });

  it('points the MCP server at the local API with OAuth sign-in', () => {
    expect(mcpEnvironment(settings)).toMatchObject({
      ADK_API_URL: 'http://127.0.0.1:3001',
      ADK_MCP_HTTP_HOST: '127.0.0.1',
      ADK_MCP_HTTP_PORT: '3334',
      ADK_MCP_PUBLIC_URL: 'http://localhost:3334',
      ADK_MCP_OAUTH_SECRET: 'm'.repeat(64),
    });
  });
});

describe('desktop environment with a cloud database', () => {
  it('points the API to the hosted database and its encryption key', () => {
    const env = backendEnvironment(settings, {
      browsersPath: '/b',
      dataDir: '/d',
      cloud: {
        url: 'postgresql://u:p@db.example.com/adk',
        integrationEncryptionKey: 'c'.repeat(64),
      },
    });
    expect(env['DATABASE_URL']).toBe('postgresql://u:p@db.example.com/adk');
    expect(env['INTEGRATION_ENCRYPTION_KEY']).toBe('c'.repeat(64));
  });
});
