import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  findItem,
  removalReason,
  satisfiesFloor,
  skillFileUrl,
  type HubIndex,
  type HubKind,
  type HubPlugin,
  type HubSkill,
} from './catalog.js';

/** What `devkit` installed from the hub, so updates and removals touch only its own files. */
export interface InstallRecord {
  readonly kind: HubKind;
  readonly name: string;
  readonly version: string;
  /** Plugins: the pinned commit. Skills: a digest of the file hashes in the index. */
  readonly revision: string;
  readonly skillsDir: string;
  readonly agentsDir?: string;
  readonly paths: readonly string[];
  readonly mcpServers: readonly string[];
  readonly installedAt: string;
}

export interface McpServerConfig {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly type?: string;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface InstallTarget {
  /** Folder that receives `<name>/SKILL.md` folders, e.g. ~/.claude/skills. */
  readonly skillsDir: string;
  /** Folder that receives plugin subagents; undefined when the client has none. */
  readonly agentsDir?: string;
  /** Replace folders that exist but were not installed by devkit. */
  readonly force?: boolean;
}

/** Fetches exactly `sha` of `repo` into the empty folder `directory`. */
export type CheckoutPinned = (repo: string, sha: string, directory: string) => Promise<void>;

export interface HubInstallerOptions {
  readonly lockFile?: string;
  readonly fetch?: typeof fetch;
  readonly checkout?: CheckoutPinned;
  readonly devkitVersion?: string;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => Date;
}

export interface InstallResult {
  readonly record: InstallRecord;
  /** MCP servers the plugin needs, for the user to register with their client. */
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
  readonly requiresEnv: readonly string[];
}

const run = promisify(execFile);

/** Default checkout: git fetches the single pinned commit; no hook or code of the plugin runs. */
export const gitCheckout: CheckoutPinned = async (repo, sha, directory) => {
  const git = async (...args: string[]) =>
    (
      await run('git', args, {
        cwd: directory,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: 120_000,
      })
    ).stdout.trim();
  try {
    await git('init', '--quiet');
  } catch {
    throw new Error('Installing plugins needs git. Install it from https://git-scm.com and retry.');
  }
  await git('fetch', '--quiet', '--depth', '1', repo, sha);
  await git('-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', 'FETCH_HEAD');
  const head = await git('rev-parse', 'HEAD');
  if (head !== sha) throw new Error(`Fetched ${head} from ${repo}, expected ${sha}.`);
};

const PLATFORM_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  linux: 'linux',
  darwin: 'macos',
  win32: 'windows',
};

/** Content digest of a skill as listed in the index; changes whenever any file changes. */
export function skillRevision(skill: HubSkill): string {
  const listing = skill.files.map((file) => `${file.path}:${file.sha256}`).join('\n');
  return createHash('sha256').update(listing).digest('hex');
}

/** True when `child` is strictly inside `parent` (relative() is absolute across Windows drives). */
function isInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path !== '' && path.split(sep)[0] !== '..' && !isAbsolute(path);
}

/** Copies a folder, refusing symbolic links so a plugin cannot point outside its own files. */
async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if ((await lstat(source)).isSymbolicLink()) {
      throw new Error(`Refusing the symbolic link ${entry.name} in the plugin.`);
    }
    if (entry.isDirectory()) await copyTree(source, target);
    else await writeFile(target, await readFile(source));
  }
}

export class HubInstaller {
  private readonly lockFile: string;
  private readonly fetcher: typeof fetch;
  private readonly checkout: CheckoutPinned;
  private readonly devkitVersion: string;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => Date;

  constructor(options: HubInstallerOptions = {}) {
    this.lockFile = options.lockFile ?? join(homedir(), '.adk', 'hub-lock.json');
    this.fetcher = options.fetch ?? fetch;
    this.checkout = options.checkout ?? gitCheckout;
    this.devkitVersion = options.devkitVersion ?? '0.0.0';
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? (() => new Date());
  }

  async installed(kind?: HubKind): Promise<readonly InstallRecord[]> {
    const records = await this.readLock();
    return kind ? records.filter((record) => record.kind === kind) : records;
  }

  async installSkill(index: HubIndex, name: string, target: InstallTarget): Promise<InstallResult> {
    const skill = findItem(index, 'skill', name);
    const removed = removalReason(index, name);
    if (removed) throw new Error(removed);
    const destination = join(resolve(target.skillsDir), skill.name);
    const records = await this.readLock();
    this.assertFree(records, destination, { kind: 'skill', name }, target.force);

    // Download and verify every file before touching the destination.
    const files: { path: string; content: Buffer }[] = [];
    for (const file of skill.files) {
      const url = skillFileUrl(index, skill, file.path);
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Could not download ${url} (${response.status}).`);
      const content = Buffer.from(await response.arrayBuffer());
      const digest = createHash('sha256').update(content).digest('hex');
      if (digest !== file.sha256) {
        throw new Error(
          `${skill.name}/${file.path} does not match the hash in the ADK Hub index; nothing was installed.`,
        );
      }
      files.push({ path: file.path, content });
    }

    await rm(destination, { recursive: true, force: true });
    for (const file of files) {
      const path = join(destination, ...file.path.split('/'));
      if (!isInside(destination, path)) throw new Error(`Refusing the path ${file.path}.`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content);
    }
    const record: InstallRecord = {
      kind: 'skill',
      name: skill.name,
      version: skill.version,
      revision: skillRevision(skill),
      skillsDir: resolve(target.skillsDir),
      paths: [destination],
      mcpServers: [],
      installedAt: this.now().toISOString(),
    };
    await this.saveRecord(records, record);
    return { record, mcpServers: {}, requiresEnv: [] };
  }

  async installPlugin(
    index: HubIndex,
    name: string,
    target: InstallTarget,
  ): Promise<InstallResult> {
    const plugin = findItem(index, 'plugin', name);
    const removed = removalReason(index, name, plugin.repo);
    if (removed) throw new Error(removed);
    this.assertCompatible(plugin);

    const skillsDir = resolve(target.skillsDir);
    const agentsDir = target.agentsDir ? resolve(target.agentsDir) : undefined;
    const destinations = [
      ...plugin.capabilities.skills.map((skill) => join(skillsDir, skill)),
      ...(agentsDir
        ? plugin.capabilities.agents.map((agent) => join(agentsDir, `${agent}.md`))
        : []),
    ];
    const records = await this.readLock();
    for (const destination of destinations) {
      this.assertFree(records, destination, { kind: 'plugin', name }, target.force);
    }

    const workdir = await mkdtemp(join(tmpdir(), 'devkit-plugin-'));
    try {
      await this.checkout(plugin.repo, plugin.sha, workdir);
      const root = plugin.subdir ? join(workdir, ...plugin.subdir.split('/')) : workdir;
      const manifest = JSON.parse(await readFile(join(root, 'adk-plugin.json'), 'utf8')) as {
        name?: string;
      };
      if (manifest.name !== plugin.name) {
        throw new Error(
          `The pinned commit is not the plugin "${plugin.name}" (adk-plugin.json says "${manifest.name}").`,
        );
      }
      // Read everything first, so a missing file leaves the destination untouched.
      for (const skill of plugin.capabilities.skills) {
        if (!existsSync(join(root, 'skills', skill, 'SKILL.md'))) {
          throw new Error(
            `The plugin declares the skill "${skill}" but skills/${skill}/SKILL.md is missing.`,
          );
        }
      }
      const servers = await this.readMcpServers(root, plugin);

      for (const skill of plugin.capabilities.skills) {
        const destination = join(skillsDir, skill);
        await rm(destination, { recursive: true, force: true });
        await copyTree(join(root, 'skills', skill), destination);
      }
      if (agentsDir) {
        await mkdir(agentsDir, { recursive: true });
        for (const agent of plugin.capabilities.agents) {
          await writeFile(
            join(agentsDir, `${agent}.md`),
            await readFile(join(root, 'agents', `${agent}.md`)),
          );
        }
      }
      const record: InstallRecord = {
        kind: 'plugin',
        name: plugin.name,
        version: plugin.version ?? plugin.sha.slice(0, 12),
        revision: plugin.sha,
        skillsDir,
        ...(agentsDir ? { agentsDir } : {}),
        paths: destinations,
        mcpServers: Object.keys(servers),
        installedAt: this.now().toISOString(),
      };
      await this.saveRecord(records, record);
      return { record, mcpServers: servers, requiresEnv: plugin.capabilities.requiresEnv };
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }

  install(
    index: HubIndex,
    kind: HubKind,
    name: string,
    target: InstallTarget,
  ): Promise<InstallResult> {
    return kind === 'skill'
      ? this.installSkill(index, name, target)
      : this.installPlugin(index, name, target);
  }

  /** Removes what devkit installed. `skillsDir` limits the removal to one client folder. */
  async remove(kind: HubKind, name: string, skillsDir?: string): Promise<readonly InstallRecord[]> {
    const records = await this.readLock();
    const matches = records.filter(
      (record) =>
        record.kind === kind &&
        record.name === name &&
        (!skillsDir || record.skillsDir === resolve(skillsDir)),
    );
    if (!matches.length) throw new Error(`The ${kind} "${name}" was not installed with devkit.`);
    for (const record of matches) {
      for (const path of record.paths) {
        const owner = [record.skillsDir, record.agentsDir].find(
          (folder) => folder !== undefined && isInside(folder, path),
        );
        if (owner) await rm(path, { recursive: true, force: true });
      }
    }
    await this.writeLock(records.filter((record) => !matches.includes(record)));
    return matches;
  }

  /**
   * Reinstalls every installed item (or the named ones) whose hub revision changed. Items that
   * left the hub are reported and kept as they are.
   */
  async update(
    index: HubIndex,
    kind: HubKind,
    names: readonly string[] = [],
  ): Promise<{ updated: InstallResult[]; current: InstallRecord[]; missing: InstallRecord[] }> {
    const records = (await this.installed(kind)).filter(
      (record) => !names.length || names.includes(record.name),
    );
    const result = {
      updated: [] as InstallResult[],
      current: [] as InstallRecord[],
      missing: [] as InstallRecord[],
    };
    for (const record of records) {
      const items: readonly (HubSkill | HubPlugin)[] =
        kind === 'skill' ? index.skills : index.plugins;
      const item = items.find((candidate) => candidate.name === record.name);
      if (!item) {
        result.missing.push(record);
        continue;
      }
      const revision = kind === 'skill' ? skillRevision(item as HubSkill) : (item as HubPlugin).sha;
      if (revision === record.revision) {
        result.current.push(record);
        continue;
      }
      result.updated.push(
        await this.install(index, kind, record.name, {
          skillsDir: record.skillsDir,
          ...(record.agentsDir ? { agentsDir: record.agentsDir } : {}),
        }),
      );
    }
    return result;
  }

  private assertCompatible(plugin: HubPlugin): void {
    if (!satisfiesFloor(this.devkitVersion, plugin.requiresDevkit)) {
      throw new Error(
        `${plugin.name} needs devkit ${plugin.requiresDevkit} (this is ${this.devkitVersion}). Update with "npm install -g @agent-devkit/cli".`,
      );
    }
    const platform = PLATFORM_NAMES[this.platform] ?? this.platform;
    if (plugin.platforms.length && !plugin.platforms.includes(platform as 'linux')) {
      throw new Error(`${plugin.name} supports ${plugin.platforms.join(', ')} only.`);
    }
  }

  private async readMcpServers(
    root: string,
    plugin: HubPlugin,
  ): Promise<Record<string, McpServerConfig>> {
    if (!plugin.capabilities.mcpServers.length) return {};
    const file = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8')) as {
      mcpServers?: Record<string, McpServerConfig>;
    };
    const servers: Record<string, McpServerConfig> = {};
    for (const id of plugin.capabilities.mcpServers) {
      const server = file.mcpServers?.[id];
      if (!server)
        throw new Error(
          `The plugin declares the MCP server "${id}" but .mcp.json does not define it.`,
        );
      servers[id] = server;
    }
    return servers;
  }

  /** A destination is free when it does not exist, belongs to this same item, or `force` is set. */
  private assertFree(
    records: readonly InstallRecord[],
    destination: string,
    item: { kind: HubKind; name: string },
    force = false,
  ): void {
    if (force || !existsSync(destination)) return;
    const owner = records.find((record) => record.paths.includes(destination));
    if (owner?.kind === item.kind && owner.name === item.name) return;
    const by = owner ? `the ${owner.kind} "${owner.name}"` : 'something not installed by devkit';
    throw new Error(
      `${destination} already exists and belongs to ${by}. Pass --force to replace it.`,
    );
  }

  private async saveRecord(
    records: readonly InstallRecord[],
    record: InstallRecord,
  ): Promise<void> {
    const others = records.filter(
      (existing) =>
        !(
          existing.kind === record.kind &&
          existing.name === record.name &&
          existing.skillsDir === record.skillsDir
        ),
    );
    await this.writeLock([...others, record]);
  }

  private async readLock(): Promise<InstallRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.lockFile, 'utf8')) as {
        installs?: InstallRecord[];
      };
      return parsed.installs ?? [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`Could not read ${this.lockFile}: ${(error as Error).message}`);
    }
  }

  private async writeLock(installs: readonly InstallRecord[]): Promise<void> {
    await mkdir(dirname(this.lockFile), { recursive: true });
    const sorted = [...installs].sort((a, b) =>
      `${a.kind}${a.name}`.localeCompare(`${b.kind}${b.name}`),
    );
    await writeFile(
      this.lockFile,
      `${JSON.stringify({ version: 1, installs: sorted }, null, 2)}\n`,
    );
  }
}
