import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Version of this package, read from its package.json (works from `src/` and `dist/src/`). */
export function packageVersion(start = dirname(fileURLToPath(import.meta.url))): string {
  let current = start;
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(join(current, 'package.json'), 'utf8')) as {
        version?: string;
      };
      return manifest.version ?? '0.0.0';
    } catch {
      const parent = dirname(current);
      if (parent === current) return '0.0.0';
      current = parent;
    }
  }
}
