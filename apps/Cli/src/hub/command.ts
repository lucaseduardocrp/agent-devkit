import { homedir } from 'node:os';
import { join } from 'node:path';
import { skillTargetDirectory } from '../commands.js';
import { fetchHubIndex, fetchLatestHubIndex, findItem, search, type HubKind } from './catalog.js';
import {
  formatInfo,
  formatInstalled,
  formatList,
  mcpInstructions,
  type HubClient,
} from './format.js';
import type { HubInstaller } from './install.js';

export interface HubCommandOptions {
  readonly hubUrl?: string;
  readonly client?: string;
  readonly scope?: string;
  readonly dir?: string;
  readonly category?: string;
  readonly force?: boolean;
  readonly json?: boolean;
}

export interface HubCommandContext {
  /** Human messages (stderr). */
  readonly say: (message: string) => void;
  /** Machine-readable output (stdout), used by --json. */
  readonly print: (message: string) => void;
  readonly installer: HubInstaller;
  readonly fetch?: typeof fetch;
  readonly cwd?: string;
  readonly home?: string;
}

export const HUB_ACTIONS = [
  'search',
  'list',
  'info',
  'install',
  'installed',
  'update',
  'remove',
] as const;

const CLIENTS: readonly HubClient[] = ['claude', 'codex', 'agents'];

function clientOf(options: HubCommandOptions): HubClient {
  const client = (options.client ?? 'claude') as HubClient;
  if (!CLIENTS.includes(client))
    throw new Error(`Unknown client: ${client}. Use claude, codex or agents.`);
  return client;
}

function targetOf(options: HubCommandOptions, context: HubCommandContext) {
  const client = clientOf(options);
  const scope = options.scope === 'project' ? 'project' : 'user';
  const base = scope === 'user' ? (context.home ?? homedir()) : (context.cwd ?? process.cwd());
  const skillsDir = options.dir ?? skillTargetDirectory(client, scope, context.cwd, context.home);
  // Subagents are a Claude Code feature; with --dir there is no client folder to put them in.
  const agentsDir =
    client === 'claude' && !options.dir ? join(base, '.claude', 'agents') : undefined;
  return { client, scope, skillsDir, agentsDir } as const;
}

/** `devkit skills …` and `devkit plugins …`. */
export async function runHubCommand(
  kind: HubKind,
  args: readonly string[],
  options: HubCommandOptions,
  context: HubCommandContext,
): Promise<void> {
  const [first, ...rest] = args;
  const action = first && (HUB_ACTIONS as readonly string[]).includes(first) ? first : 'search';
  const names = action === 'search' && first !== 'search' ? args : rest;
  const plural = `${kind}s`;
  const loadIndex = () =>
    options.hubUrl
      ? fetchHubIndex(options.hubUrl, context.fetch)
      : fetchLatestHubIndex(context.fetch);
  const { say, print, installer } = context;

  switch (action) {
    case 'search':
    case 'list': {
      const index = await loadIndex();
      const items = search(index, kind, names.join(' '), options.category);
      if (options.json) return print(JSON.stringify(items, null, 2));
      return say(formatList(index, kind, items, await installer.installed(kind)));
    }
    case 'info': {
      if (!names[0]) throw new Error(`Usage: devkit ${plural} info <name>`);
      const index = await loadIndex();
      const item =
        kind === 'skill' ? findItem(index, 'skill', names[0]) : findItem(index, 'plugin', names[0]);
      if (options.json) return print(JSON.stringify(item, null, 2));
      return say(formatInfo(index, kind, item));
    }
    case 'installed': {
      const records = await installer.installed(kind);
      if (options.json) return print(JSON.stringify(records, null, 2));
      return say(formatInstalled(records));
    }
    case 'install': {
      if (!names.length) throw new Error(`Usage: devkit ${plural} install <name> [...]`);
      const index = await loadIndex();
      const target = targetOf(options, context);
      for (const name of names) {
        const result = await installer.install(index, kind, name, {
          skillsDir: target.skillsDir,
          ...(target.agentsDir ? { agentsDir: target.agentsDir } : {}),
          ...(options.force ? { force: true } : {}),
        });
        say(`Installed ${kind} ${name} ${result.record.version} into ${target.skillsDir}.`);
        for (const line of mcpInstructions(target.client, target.scope, result.mcpServers))
          say(line);
        if (result.requiresEnv.length)
          say(`Set these environment variables first: ${result.requiresEnv.join(', ')}.`);
      }
      return say('Restart your assistant (or start a new session) to load the new skills.');
    }
    case 'update': {
      const index = await loadIndex();
      const { updated, current, missing } = await installer.update(index, kind, names);
      for (const result of updated) {
        say(
          `Updated ${kind} ${result.record.name} to ${result.record.version} in ${result.record.skillsDir}.`,
        );
      }
      for (const record of missing) {
        say(
          `${record.name} is no longer in the ADK Hub; kept as it is. Remove it with "devkit ${plural} remove ${record.name}".`,
        );
      }
      if (!updated.length && !missing.length) {
        say(
          current.length
            ? `Everything is up to date (${current.length}).`
            : `No ${plural} from the ADK Hub are installed.`,
        );
      }
      return;
    }
    case 'remove': {
      if (!names.length) throw new Error(`Usage: devkit ${plural} remove <name> [...]`);
      const only =
        options.client || options.scope || options.dir
          ? targetOf(options, context).skillsDir
          : undefined;
      for (const name of names) {
        for (const record of await installer.remove(kind, name, only)) {
          say(`Removed ${kind} ${name} from ${record.skillsDir}.`);
          for (const server of record.mcpServers) {
            say(
              `  Its MCP server "${server}" stays registered; remove it with "claude mcp remove ${server}" or "codex mcp remove ${server}".`,
            );
          }
        }
      }
      return;
    }
  }
}
