import { describe, expect, it, vi } from 'vitest';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';
import { MAX_AGENT_SKILLS, type AgentSkill } from '../src/modules/agents/domain/agent-entity.js';
import { HubAgentService } from '../src/modules/hub/application/hub-agent-service.js';
import type { HubCatalog } from '../src/modules/hub/application/hub-catalog.js';
import type { HubIndex } from '../src/modules/hub/domain/hub-index.js';

const sha = 'a'.repeat(64);
const file = (path: string) => ({ path, size: 1, sha256: sha });

function skill(name: string, files = [file('SKILL.md')]) {
  return {
    name,
    description: `${name} skill`,
    category: 'qa',
    tags: [],
    author: 'ADK',
    version: '1.0.0',
    license: 'MIT',
    tier: 'official',
    path: `skills/${name}`,
    files,
  };
}

const index = {
  schemaVersion: 1,
  repository: 'acme/hub',
  commit: 'c'.repeat(40),
  generatedAt: 'now',
  categories: { agents: [], skills: [] },
  agents: [
    {
      name: 'plain-agent',
      description: 'Plain.',
      overview: '',
      category: 'qa',
      role: 'QA',
      tags: [],
      toolsets: [],
      author: 'ADK',
      version: '1.0.0',
      license: 'MIT',
      tier: 'official',
      path: 'agents/plain-agent',
      files: [file('AGENT.md')],
    },
  ],
  skills: [skill('good'), skill('empty'), skill('huge'), skill('no-file', [file('notes.md')])],
  plugins: [
    {
      name: 'tools',
      title: 'Tools',
      description: 'Plugin description.',
      repo: 'https://github.com/acme/tools',
      sha: 'b'.repeat(40),
      subdir: '',
      maintainer: 'acme',
      tier: 'community',
      category: 'general',
      license: 'MIT',
      capabilities: { agents: ['helper'] },
    },
  ],
  removed: [],
} as unknown as HubIndex;

const markdown = (body: string, fields = '') => `---
note: x
${fields}---
${body}`;

function setup(options: { installed?: unknown[]; agent?: unknown } = {}) {
  const files: Record<string, string> = {
    'skill:good': markdown('Do good things.'),
    'skill:empty': markdown(''),
    'skill:huge': markdown('x'.repeat(64_001)),
    'agent:plain-agent': 'No title, only instructions.',
    'plugin:helper': markdown('Help out.'),
  };
  const catalog: HubCatalog = {
    index: vi.fn(async () => index),
    agentFile: vi.fn(async (_i, agent) => files[`agent:${agent.name}`]!),
    skillFile: vi.fn(async (_i, entry) => files[`skill:${entry.name}`]!),
    pluginAgentFile: vi.fn(async (_p, agent) => files[`plugin:${agent}`]!),
  };
  const agents = {
    listAgents: vi.fn(async () => options.installed ?? []),
    getAgent: vi.fn(async () => options.agent),
    createAgent: vi.fn(async (_ws: string, input: object) => ({ id: 'new', ...input })),
    updateAgent: vi.fn(async (_ws: string, id: string, input: object) => ({ id, ...input })),
  };
  const service = new HubAgentService(catalog, agents as unknown as AgentService);
  return { service, agents, catalog, files };
}

const have = (name: string): AgentSkill => ({
  name,
  description: '',
  instructions: 'kept',
  version: '0',
  revision: 'old',
});

describe('HubAgentService (edges)', () => {
  it('lists plugins without a version and hides skills that carry no SKILL.md', async () => {
    const { service } = setup();
    const catalog = await service.catalog('ws');
    expect(catalog.plugins[0]).not.toHaveProperty('version');
    expect(catalog.skills.map((entry) => entry.name)).toEqual(['good', 'empty', 'huge']);
  });

  it('refuses more skills than an agent can use, and unknown, empty or huge ones', async () => {
    const { service } = setup();
    await expect(
      service.resolveSkills(Array.from({ length: MAX_AGENT_SKILLS + 1 }, (_, i) => `s${i}`)),
    ).rejects.toMatchObject({ code: 'AGENT_TOO_MANY_SKILLS' });
    await expect(service.resolveSkills(['no-file'])).rejects.toMatchObject({
      code: 'HUB_SKILL_NOT_FOUND',
    });
    await expect(service.resolveSkills(['empty'])).rejects.toMatchObject({
      code: 'HUB_FILE_MISMATCH',
    });
    await expect(service.resolveSkills(['huge'])).rejects.toMatchObject({
      code: 'HUB_SKILL_TOO_LARGE',
    });
    expect(await service.resolveSkills(['good'])).toEqual([
      expect.objectContaining({ name: 'good', instructions: 'Do good things.' }),
    ]);
  });

  it('installs a hub agent that has no title or temperature', async () => {
    const { service, agents } = setup();
    await service.install('ws', { name: 'plain-agent' });
    const created = agents.createAgent.mock.calls[0]![1] as Record<string, unknown>;
    expect(created).toMatchObject({ name: 'plain-agent', role: 'QA', slug: 'plain-agent' });
    expect(created).not.toHaveProperty('temperature');
    await expect(service.install('ws', { name: 'missing' })).rejects.toMatchObject({
      code: 'HUB_AGENT_NOT_FOUND',
    });
  });

  it('installs one subagent of a plugin using the plugin description and version fallback', async () => {
    const { service, agents } = setup();
    await service.install('ws', { plugin: 'tools', name: 'helper' });
    expect(agents.createAgent.mock.calls[0]![1]).toMatchObject({
      name: 'helper',
      description: 'Plugin description.',
      source: { kind: 'hub-plugin', plugin: 'tools', version: 'b'.repeat(12) },
    });
    await expect(service.install('ws', { plugin: 'tools', name: 'ghost' })).rejects.toMatchObject({
      code: 'HUB_AGENT_NOT_FOUND',
    });
    await expect(service.install('ws', { plugin: 'nope' })).rejects.toMatchObject({
      code: 'HUB_AGENT_NOT_FOUND',
    });
  });

  it('updates a plugin subagent and drops skills the hub no longer has', async () => {
    const { service, agents } = setup({
      agent: {
        id: 'a1',
        skills: [have('good'), have('gone')],
        source: { kind: 'hub-plugin', name: 'helper', plugin: 'tools' },
      },
    });
    await service.update('ws', 'a1');
    const update = agents.updateAgent.mock.calls[0]![2] as { skills: AgentSkill[] };
    expect(update.skills.map((entry) => entry.name)).toEqual(['good']);
    expect(update.skills[0]!.instructions).toBe('Do good things.');
  });

  it('refuses to update a plugin agent the plugin no longer lists, or one not from the hub', async () => {
    const stale = setup({
      agent: {
        id: 'a1',
        skills: [],
        source: { kind: 'hub-plugin', name: 'ghost', plugin: 'tools' },
      },
    });
    await expect(stale.service.update('ws', 'a1')).rejects.toMatchObject({
      code: 'HUB_AGENT_NOT_FOUND',
    });
    const custom = setup({ agent: { id: 'a2', skills: [], source: undefined } });
    await expect(custom.service.update('ws', 'a2')).rejects.toMatchObject({
      code: 'HUB_AGENT_NOT_FROM_HUB',
    });
  });

  it('reports a missing name or plugin as an empty hub reference', async () => {
    const { service } = setup();
    await expect(service.install('ws', {})).rejects.toMatchObject({
      code: 'HUB_AGENT_NOT_FOUND',
      message: "'' is not in the ADK Hub.",
    });
    const orphan = setup({
      agent: { id: 'a3', skills: [], source: { kind: 'hub-plugin', name: 'helper' } },
    });
    await expect(orphan.service.update('ws', 'a3')).rejects.toMatchObject({
      code: 'HUB_AGENT_NOT_FOUND',
    });
  });

  it('reads the skills an agent file asks for and names a plugin agent by its own fields', async () => {
    const { service, agents, files } = setup();
    files['plugin:helper'] = markdown(
      'Help out.',
      'name: Friendly Helper\ndescription: Does helping.\nskills: [good]\n',
    );
    await service.install('ws', { plugin: 'tools' });
    expect(agents.createAgent.mock.calls[0]![1]).toMatchObject({
      name: 'Friendly Helper',
      description: 'Does helping.',
      skills: [expect.objectContaining({ name: 'good' })],
    });
  });
});
