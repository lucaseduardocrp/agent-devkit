// tsc writes the sandboxed preload as .cjs already; nothing else to post-process today.
// Kept as a hook so the build has one place for steps that are not TypeScript.
import { existsSync } from 'node:fs';

for (const file of ['dist/src/main/index.js', 'dist/src/preload/index.cjs']) {
  if (!existsSync(file)) {
    console.error(`Build output is missing: ${file}`);
    process.exit(1);
  }
}
