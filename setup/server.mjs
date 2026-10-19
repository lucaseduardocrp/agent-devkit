// ADK setup wizard server. Serves the page in ./public and reads/writes the repository's `.env`.
// No dependencies: runs on the official node image (setup/compose.yaml) or any Node 20+.
//
// Exit codes, read by the launchers (adk.cmd, adk.sh):
//   0  configuration saved, start ADK now
//   10 configuration saved, do not start
//   2  wizard cancelled
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, serializeEnv, stateFromEnv, createDefaultState, validate } from './public/model.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.ADK_ROOT ?? join(here, '..'));
const envPath = join(root, '.env');
const backupPath = join(root, '.env.backup');
const host = process.env.ADK_SETUP_HOST ?? '127.0.0.1';
const port = Number(process.env.ADK_SETUP_PORT ?? 4000);
const launcher = process.env.ADK_SETUP_LAUNCHER === '1';

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/model.js': ['model.js', 'text/javascript; charset=utf-8'],
  '/logo.png': ['logo.png', 'image/png'],
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; connect-src 'self' http: https:; " +
    "style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

// Only browsers on this computer may talk to the wizard: a Host check stops DNS rebinding and a
// custom header (which forces a CORS preflight we never answer) stops cross-site form posts.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLocalRequest(request) {
  const hostname = (request.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  return LOCAL_HOSTNAMES.has(hostname);
}

function send(response, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type });
  response.end(payload);
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function readState() {
  if (!existsSync(envPath)) return { exists: false, state: createDefaultState() };
  return { exists: true, state: stateFromEnv(parseEnv(readFileSync(envPath, 'utf8'))) };
}

function writeEnv(state) {
  if (existsSync(envPath)) copyFileSync(envPath, backupPath);
  const content = serializeEnv(state);
  const temporary = `${envPath}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  try {
    renameSync(temporary, envPath);
  } catch {
    // Some bind-mounted file systems refuse to replace a file by renaming; write it in place.
    writeFileSync(envPath, content, { mode: 0o600 });
    rmSync(temporary, { force: true });
  }
}

function finish(code) {
  // Let the response reach the browser before the process (and its container) stops.
  setTimeout(() => {
    server.close();
    process.exit(code);
  }, 300);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');

  if (url.pathname === '/healthz') return send(response, 200, 'ok', 'text/plain');
  if (!isLocalRequest(request)) return send(response, 403, { error: 'Forbidden host.' });

  if (request.method === 'GET' && STATIC_FILES[url.pathname]) {
    const [file, type] = STATIC_FILES[url.pathname];
    return send(response, 200, readFileSync(join(here, 'public', file)), type);
  }

  if (url.pathname.startsWith('/api/')) {
    if (request.method !== 'GET' && request.headers['x-adk-setup'] !== '1') {
      return send(response, 403, { error: 'Missing X-ADK-Setup header.' });
    }
    try {
      if (request.method === 'GET' && url.pathname === '/api/state') {
        return send(response, 200, { ...readState(), launcher, envPath: '.env' });
      }
      if (request.method === 'POST' && url.pathname === '/api/save') {
        const { state, start } = await readJson(request);
        const merged = { ...createDefaultState(), ...state };
        const errors = validate(merged);
        if (Object.keys(errors).length) return send(response, 422, { errors });
        writeEnv(merged);
        console.log(`Configuration saved to ${envPath}`);
        send(response, 200, { ok: true, launcher, backup: existsSync(backupPath) });
        return finish(start ? 0 : 10);
      }
      if (request.method === 'POST' && url.pathname === '/api/cancel') {
        console.log('Setup cancelled.');
        send(response, 200, { ok: true });
        return finish(2);
      }
    } catch (error) {
      console.error(error);
      return send(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  return send(response, 404, { error: 'Not found.' });
});

server.listen(port, host, () => {
  const shown = process.env.ADK_SETUP_PUBLIC_URL ?? `http://localhost:${port}`;
  console.log(`ADK setup wizard: open ${shown} in your browser.`);
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(2));
