import { mkdir, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ApplicationError } from '../../../../shared/errors.js';
import { isValidConfigDir, supportsConfigDir } from './cli-llm.js';
import type { CliId } from './cli-specs.js';

/**
 * Several accounts of one provider CLI on the machine that runs the API. A profile is a folder the
 * ADK creates and owns, so nobody types a path: a person names an account, picks it in a list, and
 * signs the CLI in once. Folders are kept apart per workspace.
 */
export interface CliProfile {
  readonly name: string;
  readonly path: string;
}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const LOGIN: Readonly<Partial<Record<CliId, { variable: string; command: string }>>> = {
  claude: { variable: 'CLAUDE_CONFIG_DIR', command: 'claude /login' },
  codex: { variable: 'CODEX_HOME', command: 'codex login' },
};

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME.test(name);
}

function profilesRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env['ADK_CLI_PROFILES_DIR']?.trim() || join(homedir(), '.adk', 'cli-profiles');
}

/** A workspace id becomes one folder name, whatever it contains. */
function workspaceFolder(workspaceId: string): string {
  return (
    String(workspaceId ?? '')
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .slice(0, 64) || '_'
  );
}

function cliFolder(workspaceId: string, cli: CliId, root = profilesRoot()): string {
  return join(root, workspaceFolder(workspaceId), cli);
}

function unsupported(cli: CliId): ApplicationError {
  return new ApplicationError(
    'LLM_CLI_PROFILES_UNSUPPORTED',
    `The ${cli} CLI has no separate login folder.`,
    400,
  );
}

/** The folder of a profile by name; never a path that came from a client. */
export function cliProfilePath(
  workspaceId: string,
  cli: CliId,
  name: string,
  root?: string,
): string {
  if (!supportsConfigDir(cli)) throw unsupported(cli);
  if (!isValidProfileName(name)) {
    throw new ApplicationError(
      'LLM_CLI_PROFILE_INVALID',
      'The account name must use letters, numbers, "-" or "_" (up to 32 characters).',
      400,
      [{ field: 'name' }],
    );
  }
  const path = join(cliFolder(workspaceId, cli, root), name);
  if (!isValidConfigDir(path)) {
    throw new ApplicationError(
      'LLM_CLI_INVALID_CONFIG_DIR',
      'The CLI login folder cannot be used on this machine.',
      400,
    );
  }
  return path;
}

export async function listCliProfiles(
  workspaceId: string,
  cli: CliId,
  root?: string,
): Promise<readonly CliProfile[]> {
  if (!supportsConfigDir(cli)) return [];
  const folder = cliFolder(workspaceId, cli, root);
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && isValidProfileName(entry.name))
    .map((entry) => ({ name: entry.name, path: join(folder, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function createCliProfile(
  workspaceId: string,
  cli: CliId,
  name: string,
  root?: string,
): Promise<CliProfile> {
  const path = cliProfilePath(workspaceId, cli, name, root);
  await mkdir(path, { recursive: true });
  return { name, path };
}

/**
 * Removes the login folder of a profile, and with it the CLI's saved login. Only a folder the ADK
 * made can go: the path comes from a validated name, never from the client. Deleting an account
 * that is already gone is not an error.
 */
export async function deleteCliProfile(
  workspaceId: string,
  cli: CliId,
  name: string,
  root?: string,
): Promise<void> {
  await rm(cliProfilePath(workspaceId, cli, name, root), { recursive: true, force: true });
}

/** What a person runs once, in a terminal, to sign a profile in. */
export function cliLoginCommand(cli: CliId, path: string, platform = process.platform): string {
  const login = LOGIN[cli];
  if (!login) return '';
  // `cmd /c` makes the same line work in cmd and in PowerShell.
  return platform === 'win32'
    ? `cmd /c "set ${login.variable}=${path}&& ${login.command}"`
    : `${login.variable}="${path}" ${login.command}`;
}
