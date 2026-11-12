import { existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';

/** Must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

/**
 * Serves the web app from app://adk/. The origin never changes between launches (unlike a
 * localhost port), so the browser storage that keeps the user signed in survives restarts.
 * Routes without a file fall back to index.html, as the web app does its own routing.
 */
export function serveWebApp(webRoot: string): void {
  const root = normalize(webRoot);
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const requested = normalize(join(root, decodeURIComponent(pathname)));
    const inside = requested === root || requested.startsWith(root + sep);
    const file =
      inside && existsSync(requested) && statSync(requested).isFile()
        ? requested
        : extname(pathname)
          ? null
          : join(root, 'index.html');
    if (!file) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}
