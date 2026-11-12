import { join } from 'node:path';

/**
 * Live development (`npm run dev:live`): the window loads the Vite dev server, so screens reload
 * as they are edited, and the API and MCP server run from apps/Backend and apps/Mcp, restarted
 * when their compiled output changes. Never on in a packaged app.
 */
export interface LiveMode {
  /** The Vite dev server, e.g. http://localhost:5173. */
  readonly webUrl: string;
  readonly webOrigin: string;
  readonly backendDir: string;
  readonly mcpDir: string;
  readonly migrationsDir: string;
}

export function liveModeFromEnv(
  env: NodeJS.ProcessEnv,
  appPath: string,
  packaged: boolean,
): LiveMode | undefined {
  const value = env['ADK_DESKTOP_WEB_URL']?.trim();
  if (packaged || !value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`ADK_DESKTOP_WEB_URL is not a URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`ADK_DESKTOP_WEB_URL must be an http(s) address: ${value}`);
  }
  const apps = join(appPath, '..');
  return {
    webUrl: url.toString(),
    webOrigin: url.origin,
    backendDir: join(apps, 'Backend'),
    mcpDir: join(apps, 'Mcp'),
    migrationsDir: join(apps, 'Backend', 'prisma', 'migrations'),
  };
}

/**
 * Calls `action` once a burst of calls has been quiet for `waitMs`: a TypeScript rebuild writes
 * dozens of files, and the server should restart once, after the last one.
 */
export function debounce(action: () => void, waitMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      action();
    }, waitMs);
  };
}
