import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/** Optional `adk-e2e.json` next to the project, so a team can share its local test settings. */
export const LOCAL_CONFIG_FILE = 'adk-e2e.json';

const schema = z.object({
  /** E2E run id in ADK. */
  run: z.string().trim().min(1).max(100).optional(),
  /** Address of the app on this computer, e.g. http://localhost:8014. */
  baseUrl: z.string().trim().url().optional(),
  /** Folder with the run's specs; edited files are pushed before running. */
  scripts: z.string().trim().min(1).optional(),
});

export type LocalConfig = z.infer<typeof schema>;

/** Reads the file when present; paths inside it are relative to the file. */
export async function loadLocalConfig(file: string): Promise<LocalConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const parsed = schema.safeParse(JSON.parse(raw));
  if (!parsed.success)
    throw new Error(`${file}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  return {
    ...parsed.data,
    ...(parsed.data.scripts
      ? { scripts: path.resolve(path.dirname(file), parsed.data.scripts) }
      : {}),
  };
}
