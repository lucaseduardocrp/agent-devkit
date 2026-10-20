// Copies the built MCP server (apps/Mcp) into this package, so `devkit` can start it without a
// published @agent-devkit/mcp: dist/mcp holds the compiled server (imported as `#mcp`, see
// package.json "imports") and skills/ the skills it serves and `devkit install-skills` copies.
// Run by `npm run build` after building apps/Mcp.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mcp = join(root, '..', 'Mcp');
const built = join(mcp, 'dist', 'src');

if (!existsSync(join(built, 'index.js'))) {
  console.error('apps/Mcp is not built. Run "npm ci && npm run build" in apps/Mcp first.');
  process.exit(1);
}
const targets = [
  // The standalone devkit-mcp binary is for the Docker image; the CLI has its own entry point.
  { from: built, to: join(root, 'dist', 'mcp'), skip: join(built, 'bin') },
  { from: join(mcp, 'skills'), to: join(root, 'skills') },
];
for (const { from, to, skip } of targets) {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true, filter: (source) => source !== skip });
}
console.log('embedded apps/Mcp into dist/mcp and skills/');
