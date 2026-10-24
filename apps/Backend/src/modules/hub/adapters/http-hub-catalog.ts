import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../shared/errors.js';
import type { HubCatalog } from '../application/hub-catalog.js';
import {
  agentFileOf,
  parseHubIndex,
  type HubAgentEntry,
  type HubIndex,
  type HubPluginEntry,
  type HubSkillEntry,
  skillFileOf,
} from '../domain/hub-index.js';

export const HUB_REPOSITORY = 'lucaseduardocrp/agent-devkit-hub';
const BRANCH_INDEX_URL = `https://raw.githubusercontent.com/${HUB_REPOSITORY}/main/index.json`;
/** Agent files are instructions, not bundles: anything larger is refused. */
const MAX_FILE_BYTES = 256 * 1024;

export interface HttpHubCatalogOptions {
  /** Another index (ADK_HUB_URL), e.g. a mirror for servers without access to GitHub. */
  readonly indexUrl?: string;
  /** Raises GitHub's limit of 60 anonymous API calls an hour (ADK_HUB_GITHUB_TOKEN). */
  readonly githubToken?: string;
  /** How long one index serves every workspace before it is downloaded again. */
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/**
 * Reads the ADK Hub over HTTPS. By default it asks GitHub for the newest commit of the hub and
 * reads index.json at that commit, which raw.githubusercontent.com never serves stale, so an agent
 * merged into the hub is offered within the cache time below.
 */
export class HttpHubCatalog implements HubCatalog {
  private readonly fetcher: typeof fetch;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private cached?: { readonly index: HubIndex; readonly at: number };
  private pending?: Promise<HubIndex>;

  public constructor(private readonly options: HttpHubCatalogOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.ttlMs = options.ttlMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  public async index(): Promise<HubIndex> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.index;
    this.pending ??= this.download().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  public async agentFile(index: HubIndex, agent: HubAgentEntry): Promise<string> {
    return this.checkedFile(index.repository, index.commit, agent.path, agentFileOf(agent));
  }

  public async skillFile(index: HubIndex, skill: HubSkillEntry): Promise<string> {
    const file = skillFileOf(skill);
    if (!file) {
      throw new ApplicationError('HUB_FILE_MISMATCH', `${skill.path} has no SKILL.md.`, 502);
    }
    return this.checkedFile(
      skill.repository ?? index.repository,
      skill.commit ?? index.commit,
      skill.path,
      file,
    );
  }

  /** A file at a commit, refused unless it matches the sha256 the index lists for it. */
  private async checkedFile(
    repository: string,
    commit: string,
    folder: string,
    file: { readonly path: string; readonly sha256: string },
  ): Promise<string> {
    const bytes = await this.get(
      `https://raw.githubusercontent.com/${repository}/${commit}/${folder}/${file.path}`,
    );
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new ApplicationError(
        'HUB_FILE_MISMATCH',
        `${folder}/${file.path} does not match the sha256 in the hub index.`,
        502,
      );
    }
    return bytes.toString('utf8');
  }

  public async pluginAgentFile(plugin: HubPluginEntry, agent: string): Promise<string> {
    const path = [plugin.subdir, 'agents', `${agent}.md`].filter(Boolean).join('/');
    return (await this.get(rawUrl(plugin.repo, plugin.sha, path))).toString('utf8');
  }

  private async download(): Promise<HubIndex> {
    const urls = this.options.indexUrl ? [this.options.indexUrl] : await this.latestIndexUrls();
    let lastError: unknown;
    for (const url of urls) {
      try {
        const index = parseHubIndex(
          JSON.parse((await this.get(url, 4 * 1024 * 1024)).toString('utf8')),
        );
        if (!index) throw new Error(`${url} is not an index this ADK can read.`);
        this.cached = { index, at: this.now() };
        return index;
      } catch (error) {
        lastError = error;
      }
    }
    // A stale index is better than none while GitHub is unreachable.
    if (this.cached) return this.cached.index;
    throw new ApplicationError(
      'HUB_UNAVAILABLE',
      `The ADK Hub index could not be loaded: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      503,
    );
  }

  /** The index at the newest commit, then the branch URL (at most five minutes behind). */
  private async latestIndexUrls(): Promise<readonly string[]> {
    try {
      const response = await this.fetcher(
        `https://api.github.com/repos/${HUB_REPOSITORY}/commits/main`,
        {
          headers: {
            accept: 'application/vnd.github.sha',
            ...(this.options.githubToken
              ? { authorization: `Bearer ${this.options.githubToken}` }
              : {}),
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      const commit = response.ok ? (await response.text()).trim() : '';
      if (/^[0-9a-f]{40}$/.test(commit)) {
        return [
          `https://raw.githubusercontent.com/${HUB_REPOSITORY}/${commit}/index.json`,
          BRANCH_INDEX_URL,
        ];
      }
    } catch {
      // Fall back to the branch URL.
    }
    return [BRANCH_INDEX_URL];
  }

  private async get(url: string, limit = MAX_FILE_BYTES): Promise<Buffer> {
    let response: Response;
    try {
      response = await this.fetcher(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new ApplicationError(
        'HUB_UNAVAILABLE',
        `Could not reach ${url}: ${String(error)}`,
        503,
      );
    }
    if (response.status === 404) {
      throw new ApplicationError('HUB_AGENT_NOT_FOUND', `${url} does not exist.`, 404);
    }
    if (!response.ok) {
      throw new ApplicationError('HUB_UNAVAILABLE', `${url} answered ${response.status}.`, 503);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) {
      throw new ApplicationError('HUB_FILE_MISMATCH', `${url} is larger than ${limit} bytes.`, 502);
    }
    return bytes;
  }
}

/** Raw file URL at a commit, for the hosts the hub accepts plugins from. */
export function rawUrl(repo: string, sha: string, path: string): string {
  const url = new URL(repo.replace(/\.git$/, ''));
  const project = url.pathname.replace(/^\/+|\/+$/g, '');
  switch (url.hostname) {
    case 'github.com':
      return `https://raw.githubusercontent.com/${project}/${sha}/${path}`;
    case 'gitlab.com':
      return `https://gitlab.com/${project}/-/raw/${sha}/${path}`;
    case 'codeberg.org':
      return `https://codeberg.org/${project}/raw/commit/${sha}/${path}`;
    default:
      throw new ApplicationError(
        'HUB_UNAVAILABLE',
        `Plugins from ${url.hostname} are not supported.`,
        503,
      );
  }
}
