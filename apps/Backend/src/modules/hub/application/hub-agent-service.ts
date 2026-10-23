import { ApplicationError } from '../../../shared/errors.js';
import type { AgentService } from '../../agents/application/agent-service.js';
import type { AgentSource, CustomAgent } from '../../agents/domain/agent-entity.js';
import { parseAgentMarkdown } from '../domain/agent-markdown.js';
import {
  agentFileOf,
  type HubAgentEntry,
  type HubIndex,
  type HubPluginEntry,
} from '../domain/hub-index.js';
import type { HubCatalog } from './hub-catalog.js';

export type HubInstallStatus = 'available' | 'installed' | 'update-available';

export interface HubInstalledAgent {
  readonly agentId: string;
  readonly name: string;
  readonly version: string;
}

interface InstallState {
  readonly status: HubInstallStatus;
  readonly installed?: HubInstalledAgent;
}

export type HubAgentView = Omit<HubAgentEntry, 'files' | 'path'> & InstallState;

export interface HubPluginView {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly version?: string;
  readonly maintainer: string;
  readonly tier: HubPluginEntry['tier'];
  readonly license: string;
  readonly repo: string;
  readonly sha: string;
  readonly agents: readonly ({ readonly name: string } & InstallState)[];
}

export interface HubAgentCatalog {
  readonly generatedAt: string;
  readonly categories: HubIndex['categories']['agents'];
  readonly agents: readonly HubAgentView[];
  /** Plugins that ship subagents; the ones without agents have nothing to install here. */
  readonly plugins: readonly HubPluginView[];
}

/** What to install: a hub agent, one subagent of a plugin, or (no name) all of a plugin's. */
export interface HubAgentRef {
  readonly name?: string;
  readonly plugin?: string;
}

/** A hub item resolved to the agent ADK stores. */
interface AgentDefinition {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly role?: CustomAgent['role'];
  readonly temperature?: number;
  readonly source: AgentSource;
}

const sameSource = (a: AgentSource, b: Pick<AgentSource, 'kind' | 'name' | 'plugin'>) =>
  a.kind === b.kind && a.name === b.name && (a.plugin ?? '') === (b.plugin ?? '');

/**
 * Installs ADK Hub agents (agents/<name>/AGENT.md) and plugin subagents as workspace agents. The
 * agents are created through AgentService, so they get the same validation as hand-made ones
 * (prompt-injection guard, unique slug), and they remember their source so they can be updated.
 */
export class HubAgentService {
  public constructor(
    private readonly catalogPort: HubCatalog,
    private readonly agents: AgentService,
  ) {}

  public async catalog(workspaceId: string): Promise<HubAgentCatalog> {
    const [index, installed] = await Promise.all([
      this.catalogPort.index(),
      this.installedAgents(workspaceId),
    ]);
    const state = (
      source: Pick<AgentSource, 'kind' | 'name' | 'plugin'>,
      revision: string,
    ): InstallState => {
      const agent = installed.find((candidate) => sameSource(candidate.source, source));
      if (!agent) return { status: 'available' };
      return {
        status: agent.source.revision === revision ? 'installed' : 'update-available',
        installed: { agentId: agent.id, name: agent.name, version: agent.source.version },
      };
    };
    return {
      generatedAt: index.generatedAt,
      categories: index.categories.agents,
      agents: available(index, index.agents).map((entry) => {
        const { files: _files, path: _path, ...agent } = entry;
        return {
          ...agent,
          ...state({ kind: 'hub-agent', name: entry.name }, agentFileOf(entry).sha256),
        };
      }),
      plugins: available(index, index.plugins)
        .filter((plugin) => plugin.capabilities.agents.length > 0)
        .map((plugin) => ({
          name: plugin.name,
          title: plugin.title,
          description: plugin.description,
          ...(plugin.version ? { version: plugin.version } : {}),
          maintainer: plugin.maintainer,
          tier: plugin.tier,
          license: plugin.license,
          repo: plugin.repo,
          sha: plugin.sha,
          agents: plugin.capabilities.agents.map((name) => ({
            name,
            ...state({ kind: 'hub-plugin', name, plugin: plugin.name }, plugin.sha),
          })),
        })),
    };
  }

  /** Installs one hub agent, one plugin subagent, or every subagent of a plugin not yet installed. */
  public async install(workspaceId: string, ref: HubAgentRef): Promise<readonly CustomAgent[]> {
    const index = await this.catalogPort.index();
    const installed = await this.installedAgents(workspaceId);
    const refuseInstalled = (source: Pick<AgentSource, 'kind' | 'name' | 'plugin'>) => {
      const existing = installed.find((agent) => sameSource(agent.source, source));
      if (existing) {
        throw new ApplicationError(
          'HUB_AGENT_INSTALLED',
          `${source.name} is already installed as '${existing.name}'.`,
          409,
          [{ agentId: existing.id }],
          { agent: existing.name },
        );
      }
    };

    if (!ref.plugin) {
      const entry = this.findAgent(index, ref.name);
      refuseInstalled({ kind: 'hub-agent', name: entry.name });
      return [await this.create(workspaceId, await this.fromHubAgent(index, entry))];
    }
    const plugin = this.findPlugin(index, ref.plugin);
    if (ref.name) {
      if (!plugin.capabilities.agents.includes(ref.name))
        throw notFound(`${plugin.name}/${ref.name}`);
      refuseInstalled({ kind: 'hub-plugin', name: ref.name, plugin: plugin.name });
      return [await this.create(workspaceId, await this.fromPlugin(plugin, ref.name))];
    }
    const pending = plugin.capabilities.agents.filter(
      (name) =>
        !installed.some((agent) =>
          sameSource(agent.source, { kind: 'hub-plugin', name, plugin: plugin.name }),
        ),
    );
    // Download and check every file before creating anything, so a bad file installs nothing.
    const definitions = await Promise.all(pending.map((name) => this.fromPlugin(plugin, name)));
    const created: CustomAgent[] = [];
    for (const definition of definitions) created.push(await this.create(workspaceId, definition));
    return created;
  }

  /**
   * Replaces an installed agent's name, description and instructions with the current hub
   * version. The workspace's own choices (model, temperature, role, parent) are kept.
   */
  public async update(workspaceId: string, agentId: string): Promise<CustomAgent> {
    const agent = await this.agents.getAgent(workspaceId, agentId);
    const source = agent.source;
    if (!source) {
      throw new ApplicationError(
        'HUB_AGENT_NOT_FROM_HUB',
        `Agent '${agentId}' was not installed from the ADK Hub.`,
        400,
      );
    }
    const index = await this.catalogPort.index();
    const definition =
      source.kind === 'hub-agent'
        ? await this.fromHubAgent(index, this.findAgent(index, source.name))
        : await this.fromPlugin(this.findPlugin(index, source.plugin), source.name, true);
    return this.agents.updateAgent(workspaceId, agentId, {
      name: definition.name,
      description: definition.description,
      instructions: definition.instructions,
      source: definition.source,
    });
  }

  private async installedAgents(workspaceId: string) {
    return (await this.agents.listAgents(workspaceId)).flatMap((agent) =>
      agent.source ? [{ id: agent.id, name: agent.name, source: agent.source }] : [],
    );
  }

  private findAgent(index: HubIndex, name: string | undefined): HubAgentEntry {
    const entry = available(index, index.agents).find((agent) => agent.name === name);
    if (!entry) throw notFound(name ?? '');
    return entry;
  }

  private findPlugin(index: HubIndex, name: string | undefined): HubPluginEntry {
    const plugin = available(index, index.plugins).find((candidate) => candidate.name === name);
    if (!plugin) throw notFound(name ?? '');
    return plugin;
  }

  private async fromHubAgent(index: HubIndex, entry: HubAgentEntry): Promise<AgentDefinition> {
    const markdown = parseAgentMarkdown(await this.catalogPort.agentFile(index, entry));
    return {
      slug: entry.name,
      name: displayName(markdown.title ?? entry.name),
      description: entry.description.slice(0, 500),
      instructions: markdown.instructions,
      role: entry.role,
      ...(entry.temperature !== undefined ? { temperature: entry.temperature } : {}),
      source: {
        kind: 'hub-agent',
        name: entry.name,
        version: entry.version,
        revision: agentFileOf(entry).sha256,
      },
    };
  }

  private async fromPlugin(
    plugin: HubPluginEntry,
    name: string,
    mustBeListed = false,
  ): Promise<AgentDefinition> {
    if (mustBeListed && !plugin.capabilities.agents.includes(name))
      throw notFound(`${plugin.name}/${name}`);
    const markdown = parseAgentMarkdown(await this.catalogPort.pluginAgentFile(plugin, name));
    return {
      slug: name,
      name: displayName(markdown.title ?? markdown.fields['name'] ?? name),
      description: (markdown.fields['description'] ?? plugin.description).slice(0, 500),
      instructions: markdown.instructions,
      role: 'CUSTOM',
      source: {
        kind: 'hub-plugin',
        name,
        plugin: plugin.name,
        version: plugin.version ?? plugin.sha.slice(0, 12),
        revision: plugin.sha,
      },
    };
  }

  private create(workspaceId: string, definition: AgentDefinition): Promise<CustomAgent> {
    return this.agents.createAgent(workspaceId, {
      name: definition.name,
      slug: definition.slug,
      description: definition.description,
      instructions: definition.instructions,
      ...(definition.role ? { role: definition.role } : {}),
      ...(definition.temperature !== undefined ? { temperature: definition.temperature } : {}),
      source: definition.source,
    });
  }
}

/** Items removed from the hub for security or policy reasons are never offered or installed. */
function available<T extends { name: string; repo?: string }>(
  index: HubIndex,
  items: readonly T[],
) {
  const repo = (value?: string) => value?.replace(/\.git$/, '').toLowerCase();
  return items.filter(
    (item) =>
      !index.removed.some(
        (removed) =>
          removed.name === item.name || (item.repo && repo(removed.repo) === repo(item.repo)),
      ),
  );
}

function displayName(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 100);
}

function notFound(name: string): ApplicationError {
  return new ApplicationError('HUB_AGENT_NOT_FOUND', `'${name}' is not in the ADK Hub.`, 404);
}
