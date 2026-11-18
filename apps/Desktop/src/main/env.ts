import { readEnvValue } from './backup-format.js';
import type { DesktopSettings } from './settings.js';

export const APP_ORIGIN = 'app://adk';

export function databaseUrl(settings: DesktopSettings): string {
  const password = encodeURIComponent(settings.databasePassword);
  return `postgresql://adk:${password}@127.0.0.1:${settings.databasePort}/adk`;
}

export const apiUrl = (settings: DesktopSettings): string => `http://127.0.0.1:${settings.apiPort}`;
export const mcpUrl = (settings: DesktopSettings): string =>
  `http://localhost:${settings.mcpPort}/mcp`;

/**
 * The R2 bucket is one for everything: test videos and screenshots (`e2e/`) and attachments
 * (`attachments/`) differ only by the folder, so the bucket and its keys are the E2E ones.
 */
const STORAGE_KEYS = [
  'E2E_R2_URL',
  'E2E_R2_ACCESS_KEY_ID',
  'E2E_R2_SECRET_ACCESS_KEY',
  'E2E_R2_PREFIX',
  'ATTACHMENTS_R2_PREFIX',
] as const;

/**
 * The file storage of a .env (the one of apps/Backend while developing): only the R2 settings,
 * because everything else in it (database, ports) belongs to the app. Without them the API keeps
 * the files in its own database, where the videos and screenshots stored in R2 are not found.
 */
export function storageEnvironment(envText: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const key of STORAGE_KEYS) {
    const value = readEnvValue(envText, key);
    if (value) found[key] = value;
  }
  return found;
}

/**
 * The environment of the API process. It listens on this computer only, keeps its cache in memory
 * (no Redis) and runs E2E, integration and load tests itself (no separate worker).
 */
export function backendEnvironment(
  settings: DesktopSettings,
  options: {
    readonly browsersPath: string;
    readonly dataDir: string;
    /** Where the web app is served; the live mode uses the Vite dev server. */
    readonly frontendUrl?: string;
    /** A hosted PostgreSQL that holds the data instead of the one on this computer. */
    readonly cloud?: { readonly url: string; readonly integrationEncryptionKey: string };
    /** Where the files (videos, screenshots, attachments) are kept; see storageEnvironment. */
    readonly storage?: Record<string, string>;
  },
): Record<string, string> {
  return {
    ...options.storage,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(settings.apiPort),
    DATABASE_PROVIDER: 'postgres',
    DATABASE_URL: options.cloud?.url ?? databaseUrl(settings),
    INTEGRATION_ENCRYPTION_KEY:
      options.cloud?.integrationEncryptionKey ?? settings.integrationEncryptionKey,
    OAUTH_STATE_SECRET: settings.oauthStateSecret,
    API_PUBLIC_URL: apiUrl(settings),
    FRONTEND_URL: options.frontendUrl ?? APP_ORIGIN,
    PLAYWRIGHT_BROWSERS_PATH: options.browsersPath,
    API_TESTS_ALLOW_PRIVATE_NETWORK: 'true',
    // The tests run on this computer, so a target on localhost is the user's own app: no
    // `devkit runner` or tunnel needed. Safe because the API listens on 127.0.0.1 only (the Docker
    // install turns this on under the same condition, with host.docker.internal as the alias).
    ADK_HOST_ACCESS: 'true',
    ADK_HOST_ALIAS: 'localhost',
    ADK_DESKTOP: '1',
    // The API runs as the person at this computer, so the Claude, Codex and Gemini CLIs they are
    // signed in to can stand in for an API key (Connect, "AI CLI"). Only the local user reaches it.
    ADK_LLM_CLI: 'true',
    ADK_DATA_DIR: options.dataDir,
  };
}

/** The MCP server for assistants on this computer; it signs users in through ADK (OAuth). */
export function mcpEnvironment(settings: DesktopSettings): Record<string, string> {
  return {
    NODE_ENV: 'production',
    ADK_API_URL: apiUrl(settings),
    ADK_MCP_HTTP_HOST: '127.0.0.1',
    ADK_MCP_HTTP_PORT: String(settings.mcpPort),
    ADK_MCP_PUBLIC_URL: `http://localhost:${settings.mcpPort}`,
    ADK_MCP_OAUTH_SECRET: settings.mcpOauthSecret,
  };
}
