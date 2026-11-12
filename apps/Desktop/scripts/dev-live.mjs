// `npm run dev:live`: the desktop app with live reload, for working on screens and features.
//
//   apps/Frontend  Vite dev server; the window loads it, so edits show up at once (HMR)
//   apps/Backend   tsc --watch; the app restarts the API when its output changes
//   apps/Mcp       tsc --watch; the app restarts the MCP server when its output changes
//
// The data lives apart from the installed app's ("Agent DevKit Dev" in the user's app data).
// Closing the window, or Ctrl+C here, stops everything.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const apps = join(desktop, '..');
const backend = join(apps, 'Backend');
const frontend = join(apps, 'Frontend');
const mcp = join(apps, 'Mcp');
const WEB_PORT = Number(process.env['ADK_DESKTOP_WEB_PORT'] ?? 5173);
const WEB_URL = `http://localhost:${WEB_PORT}`;

const children = new Set();
const colors = { api: 36, mcp: 35, web: 33, app: 32 };
const tag = (name) => `\u001b[${colors[name]}m[${name}]\u001b[0m`;

function prefixed(stream, name) {
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const lines = (rest + chunk).split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) console.log(`${tag(name)} ${line}`);
  });
}

function run(command, cwd, env = {}) {
  console.log(`> ${command}   (${cwd})`);
  const result = spawnSync(command, {
    cwd,
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    console.error(`Failed: ${command}`);
    process.exit(result.status ?? 1);
  }
}

/** Starts a long-running process; resolves when `ready` matches its output. */
function start(name, command, cwd, { env = {}, ready } = {}) {
  const child = spawn(command, {
    cwd,
    shell: true,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  prefixed(child.stdout, name);
  prefixed(child.stderr, name);
  if (!ready) return Promise.resolve(child);
  return new Promise((resolve, reject) => {
    const check = (chunk) => {
      if (ready.test(String(chunk))) resolve(child);
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.once('exit', (code) => reject(new Error(`${name} exited (${code}) before it was ready`)));
  });
}

function stopAll() {
  for (const child of children) {
    if (child.exitCode !== null || !child.pid) continue;
    // A shell starts each one: stop the whole tree.
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  }
}

process.once('SIGINT', () => {
  stopAll();
  process.exit(130);
});

const install = (cwd) => {
  if (!existsSync(join(cwd, 'node_modules'))) run('npm ci', cwd);
};
for (const dir of [backend, frontend, mcp]) install(dir);

// The Prisma client is generated once; generation only validates the URL shape.
run('npm run prisma:generate', backend, { DATABASE_URL: 'postgresql://localhost/build' });

// tsc's first watch pass compiles everything; the app starts only after it, so that pass does
// not trigger a restart.
const watchReady = /Watching for file changes/;
const watchCommand = 'npx tsc -p tsconfig.build.json --watch --preserveWatchOutput';
try {
  await Promise.all([
    start('api', watchCommand, backend, { ready: watchReady }),
    start('mcp', watchCommand, mcp, { ready: watchReady }),
    start('web', `npx vite --port ${WEB_PORT} --strictPort`, frontend, { ready: /ready in/i }),
  ]);
} catch (error) {
  console.error(String(error));
  stopAll();
  process.exit(1);
}

run('npm run build', desktop);

// VS Code's terminal can set ELECTRON_RUN_AS_NODE, which would run Electron as plain Node.
const appEnv = { ...process.env, ADK_DESKTOP_WEB_URL: WEB_URL };
delete appEnv['ELECTRON_RUN_AS_NODE'];
const electron = spawn('npx electron .', {
  cwd: desktop,
  shell: true,
  env: appEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.add(electron);
prefixed(electron.stdout, 'app');
prefixed(electron.stderr, 'app');
electron.once('exit', (code) => {
  children.delete(electron);
  stopAll();
  process.exit(code ?? 0);
});
