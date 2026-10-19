import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SkillFile {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly content: string;
}

/** Walks up from this file to the package root (works from `src/` and from `dist/src/`). */
export function packageRoot(start = dirname(fileURLToPath(import.meta.url))): string {
  let current = start;
  while (!existsSync(join(current, 'package.json'))) {
    const parent = dirname(current);
    if (parent === current) throw new Error('Could not locate the devkit package root.');
    current = parent;
  }
  return current;
}

export function skillsDirectory(): string {
  return join(packageRoot(), 'skills');
}

export function parseFrontmatter(content: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  const fields: Record<string, string> = {};
  for (const line of match?.[1]?.split(/\r?\n/) ?? []) {
    const separator = line.indexOf(':');
    if (separator > 0) {
      fields[line.slice(0, separator).trim()] = line
        .slice(separator + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
    }
  }
  return fields;
}

/** Loads the portable `skills/<name>/SKILL.md` files shipped with the package. */
export async function loadSkills(directory = skillsDirectory()): Promise<readonly SkillFile[]> {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && existsSync(join(directory, entry.name, 'SKILL.md')))
      .map(async (entry) => {
        const path = join(directory, entry.name, 'SKILL.md');
        const content = await readFile(path, 'utf8');
        const meta = parseFrontmatter(content);
        return {
          name: meta['name'] ?? entry.name,
          description: meta['description'] ?? '',
          path,
          content,
        };
      }),
  );
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
