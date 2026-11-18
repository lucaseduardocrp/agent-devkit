import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** What the desktop app remembers between launches, in the user's data folder. */
export interface DesktopSettings {
  readonly apiPort: number;
  readonly mcpPort: number;
  readonly databasePort: number;
  /** Encrypts the integrations saved in ADK; losing it makes them unreadable. */
  readonly integrationEncryptionKey: string;
  readonly oauthStateSecret: string;
  readonly mcpOauthSecret: string;
  readonly databasePassword: string;
  /** Set while ADK keeps its data in a hosted PostgreSQL instead of the one on this computer. */
  readonly cloudDatabase?: CloudDatabaseSettings;
}

export interface CloudDatabaseSettings {
  /** The connection URL, sealed with the system keychain (see sealSecret). */
  readonly url: string;
  /** Encrypts the integrations saved in that database, which may differ from this computer's. */
  readonly integrationEncryptionKey: string;
}

function readCloudDatabase(value: unknown): CloudDatabaseSettings | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { url, integrationEncryptionKey } = value as Record<string, unknown>;
  return typeof url === 'string' &&
    typeof integrationEncryptionKey === 'string' &&
    url &&
    integrationEncryptionKey
    ? { url, integrationEncryptionKey }
    : undefined;
}

export const PREFERRED_PORTS = { apiPort: 3000, mcpPort: 3333, databasePort: 54329 } as const;

export const newSecret = (): string => randomBytes(32).toString('hex');

const PORT_KEYS = ['apiPort', 'mcpPort', 'databasePort'] as const;
const SECRET_KEYS = [
  'integrationEncryptionKey',
  'oauthStateSecret',
  'mcpOauthSecret',
  'databasePassword',
] as const;

/**
 * Completes what was saved: keeps the secrets and ports already chosen, generates the missing
 * secrets, and asks `pickPort` for a free port whenever the saved (or preferred) one is taken.
 */
export async function completeSettings(
  saved: Partial<Record<keyof DesktopSettings, unknown>>,
  pickPort: (preferred: number, taken: readonly number[]) => Promise<number>,
  secret: () => string = newSecret,
): Promise<DesktopSettings> {
  const result: Record<string, string | number> = {};
  const taken: number[] = [];
  for (const key of PORT_KEYS) {
    const savedPort = saved[key];
    const wanted = typeof savedPort === 'number' ? savedPort : PREFERRED_PORTS[key];
    const port = await pickPort(wanted, taken);
    taken.push(port);
    result[key] = port;
  }
  for (const key of SECRET_KEYS) {
    const value = saved[key];
    result[key] = typeof value === 'string' && value.length >= 32 ? value : secret();
  }
  const cloudDatabase = readCloudDatabase(saved.cloudDatabase);
  return { ...(result as unknown as DesktopSettings), ...(cloudDatabase ? { cloudDatabase } : {}) };
}

export async function readSettingsFile(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Written to a temporary file first so a crash never leaves half a settings file. */
export async function writeSettingsFile(file: string, settings: DesktopSettings): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.settings-${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}
