// Builds the API, the MCP server and the web app and lays them out in apps/Desktop/stage/, the
// folder electron-builder ships next to the app (and `npm start` uses in development):
//   stage/backend    dist/src, prisma/migrations and production node_modules
//   stage/mcp        dist/src, skills and production node_modules
//   stage/frontend   the Vite build
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const apps = join(desktop, '..');
const stage = join(desktop, 'stage');

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

const install = (cwd) => {
  if (!existsSync(join(cwd, 'node_modules'))) run('npm ci', cwd);
};

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// Web app
const frontend = join(apps, 'Frontend');
install(frontend);
run('npm run build', frontend);
cpSync(join(frontend, 'dist'), join(stage, 'frontend'), { recursive: true });

// API: generating the Prisma client only validates the URL shape, it never connects.
const backend = join(apps, 'Backend');
install(backend);
run('npm run build', backend, { DATABASE_URL: 'postgresql://localhost/build' });
const apiStage = join(stage, 'backend');
cpSync(join(backend, 'dist', 'src'), join(apiStage, 'dist', 'src'), { recursive: true });
cpSync(join(backend, 'prisma', 'migrations'), join(apiStage, 'prisma', 'migrations'), {
  recursive: true,
});
cpSync(join(backend, 'package.json'), join(apiStage, 'package.json'));
cpSync(join(backend, 'package-lock.json'), join(apiStage, 'package-lock.json'));
run('npm ci --omit=dev', apiStage);

// MCP server
const mcp = join(apps, 'Mcp');
install(mcp);
run('npm run build', mcp);
const mcpStage = join(stage, 'mcp');
cpSync(join(mcp, 'dist', 'src'), join(mcpStage, 'dist', 'src'), { recursive: true });
if (existsSync(join(mcp, 'skills')))
  cpSync(join(mcp, 'skills'), join(mcpStage, 'skills'), { recursive: true });
cpSync(join(mcp, 'package.json'), join(mcpStage, 'package.json'));
cpSync(join(mcp, 'package-lock.json'), join(mcpStage, 'package-lock.json'));
run('npm ci --omit=dev', mcpStage);

console.log('Staged in', stage);
