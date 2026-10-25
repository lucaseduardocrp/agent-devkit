import { ApplicationError } from '../../../shared/errors.js';
import type { AgentService } from '../../agents/application/agent-service.js';
import {
  MAX_AGENT_SKILLS,
  type AgentSkill,
  type AgentSource,
  type CustomAgent,
} from '../../agents/domain/agent-entity.js';
import { parseAgentMarkdown } from '../domain/agent-markdown.js';
import {
  agentFileOf,
  skillFileOf,
  type HubAgentEntry,
  type HubIndex,
  type HubPluginEntry,
  type HubSkillEntry,
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
  readonly skillCategories: HubIndex['categories']['skills'];
  /** Skills an agent can use. */
  readonly skills: readonly HubSkillView[];
}

/** A hub skill; `revision` tells an agent's copy apart from the hub's current one. */
export type HubSkillView = Omit<HubSkillEntry, 'files' | 'path' | 'repository' | 'commit'> & {
  readonly revision: string;
};

/** A skill's instructions above this size would crowd out the agent's own prompt. */
const MAX_SKILL_CHARACTERS = 64_000;

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
  readonly role: CustomAgent['role'];
  readonly temperature?: number;
  readonly source: AgentSource;
  /** Hub skills the agent file asks for (`skills: a, b` in its front matter). */
  readonly skills: readonly string[];
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
      skillCategories: index.categories.skills,
      skills: available(index, index.skills).flatMap((entry) => {
        const file = skillFileOf(entry);
        if (!file) return [];
        const { files: _files, path: _path, repository: _repo, commit: _commit, ...skill } = entry;
        return [{ ...skill, revision: file.sha256 }];
      }),
    };
  }

  /**
   * Turns the skill names an agent should use into copies of their SKILL.md, read from the hub and
   * checked against its index. Skills the agent already has keep their copy unless they are named
   * in `refresh`, so saving an agent never changes the skills it runs with behind the user's back.
   */
  public async resolveSkills(
    names: readonly string[],
    current: readonly AgentSkill[] = [],
    refresh: readonly string[] = [],
  ): Promise<AgentSkill[]> {
    const wanted = [...new Set(names)];
    if (wanted.length > MAX_AGENT_SKILLS) {
      throw new ApplicationError(
        'AGENT_TOO_MANY_SKILLS',
        `An agent can use at most ${MAX_AGENT_SKILLS} skills.`,
        400,
        [{ field: 'skills' }],
      );
    }
    const kept = (name: string) =>
      refresh.includes(name) ? undefined : current.find((skill) => skill.name === name);
    if (wanted.every(kept)) return wanted.map((name) => kept(name)!);
    const index = await this.catalogPort.index();
    return Promise.all(
      wanted.map(
        async (name) => kept(name) ?? (await this.fromHubSkill(index, this.findSkill(index, name))),
      ),
    );
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
      return [
        await this.create(
          workspaceId,
          await this.withSkills(await this.fromHubAgent(index, entry)),
        ),
      ];
    }
    const plugin = this.findPlugin(index, ref.plugin);
    if (ref.name) {
      if (!plugin.capabilities.agents.includes(ref.name))
        throw notFound(`${plugin.name}/${ref.name}`);
      refuseInstalled({ kind: 'hub-plugin', name: ref.name, plugin: plugin.name });
      return [
        await this.create(
          workspaceId,
          await this.withSkills(await this.fromPlugin(plugin, ref.name)),
        ),
      ];
    }
    const pending = plugin.capabilities.agents.filter(
      (name) =>
        !installed.some((agent) =>
          sameSource(agent.source, { kind: 'hub-plugin', name, plugin: plugin.name }),
        ),
    );
    // Download and check every file before creating anything, so a bad file installs nothing.
    const definitions = await Promise.all(
      pending.map(async (name) => this.withSkills(await this.fromPlugin(plugin, name))),
    );
    const created: CustomAgent[] = [];
    for (const definition of definitions) created.push(await this.create(workspaceId, definition));
    return created;
  }

  /**
   * Replaces an installed agent's name, description and instructions with the current hub
   * version, and brings its skills to their current hub version. The workspace's own choices
   * (model, temperature, role, parent, which skills it uses) are kept; skills taken out of the
   * hub are dropped.
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
    const names = agent.skills
      .map((skill) => skill.name)
      .filter((name) => available(index, index.skills).some((entry) => entry.name === name));
    return this.agents.updateAgent(workspaceId, agentId, {
      name: definition.name,
      description: definition.description,
      instructions: definition.instructions,
      source: definition.source,
      skills: await this.resolveSkills(names, agent.skills, names),
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

  private findSkill(index: HubIndex, name: string): HubSkillEntry {
    const entry = available(index, index.skills).find((skill) => skill.name === name);
    if (!entry || !skillFileOf(entry)) {
      throw new ApplicationError(
        'HUB_SKILL_NOT_FOUND',
        `The skill '${name}' is not in the ADK Hub.`,
        404,
        [{ field: 'skills' }],
        { skill: name },
      );
    }
    return entry;
  }

  private async fromHubSkill(index: HubIndex, entry: HubSkillEntry): Promise<AgentSkill> {
    const markdown = parseAgentMarkdown(await this.catalogPort.skillFile(index, entry));
    if (!markdown.instructions) {
      throw new ApplicationError('HUB_FILE_MISMATCH', `${entry.path}/SKILL.md is empty.`, 502);
    }
    if (markdown.instructions.length > MAX_SKILL_CHARACTERS) {
      throw new ApplicationError(
        'HUB_SKILL_TOO_LARGE',
        `The skill '${entry.name}' is too large for an agent (at most ${MAX_SKILL_CHARACTERS} characters).`,
        400,
        [{ field: 'skills' }],
        { skill: entry.name },
      );
    }
    return {
      name: entry.name,
      description: entry.description.slice(0, 1024),
      instructions: markdown.instructions,
      version: entry.version,
      revision: skillFileOf(entry)!.sha256,
    };
  }

  /** Reads the skills an agent file asks for, before the agent is created. */
  private async withSkills(
    definition: AgentDefinition,
  ): Promise<AgentDefinition & { readonly resolvedSkills: readonly AgentSkill[] }> {
    return { ...definition, resolvedSkills: await this.resolveSkills(definition.skills) };
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
      skills: skillList(markdown.fields['skills']),
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
      skills: skillList(markdown.fields['skills']),
    };
  }

  private create(
    workspaceId: string,
    definition: AgentDefinition & { readonly resolvedSkills: readonly AgentSkill[] },
  ): Promise<CustomAgent> {
    return this.agents.createAgent(workspaceId, {
      name: definition.name,
      slug: definition.slug,
      description: definition.description,
      instructions: definition.instructions,
      role: definition.role,
      ...(definition.temperature !== undefined ? { temperature: definition.temperature } : {}),
      source: definition.source,
      skills: definition.resolvedSkills,
    });
  }
}

/** `skills: a, b` or `skills: [a, b]` in an agent's front matter. */
function skillList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((name) => name.trim().replace(/^(["'])(.*)\1$/, '$2'))
    .filter(Boolean);
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
