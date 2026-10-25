import { describe, expect, it, vi } from 'vitest';
import type { AdkApi, ApiRequest, HubAgentCatalogDto } from '#mcp';
import { runAgentsCommand } from '../src/hub/agents-command.js';

const catalog: HubAgentCatalogDto = {
  generatedAt: '2026-10-23T12:00:00Z',
  categories: [],
  agents: [
    {
      name: 'qa-test-designer',
      description: 'Writes traceable test cases.',
      overview: '',
      category: 'qa',
      role: 'QA',
      tags: ['bdd'],
      toolsets: [],
      author: 'ADK',
      version: '1.1.0',
      license: 'MIT',
      tier: 'official',
      status: 'update-available',
      installed: { agentId: 'a1', name: 'QA test designer', version: '1.0.0' },
    },
    {
      name: 'technical-writer',
      description: 'Documents features in the Brain.',
      overview: '',
      category: 'documentation',
      role: 'DOCUMENTATION',
      tags: [],
      toolsets: [],
      author: 'ADK',
      version: '1.0.0',
      license: 'MIT',
      tier: 'official',
      status: 'available',
    },
  ],
  plugins: [
    {
      name: 'jira-qa',
      title: 'Jira QA',
      description: 'Jira agents.',
      version: '2.0.0',
      maintainer: 'acme',
      tier: 'community',
      license: 'MIT',
      repo: 'https://github.com/acme/adk-jira',
      sha: 'a'.repeat(40),
      agents: [
        {
          name: 'jira-reviewer',
          status: 'installed',
          installed: { agentId: 'p1', name: 'Jira reviewer', version: '2.0.0' },
        },
      ],
    },
  ],
};

function setup(
  hub: HubAgentCatalogDto = catalog,
  installed: (body: { name?: string; plugin?: string }) => unknown[] = (body) => [
    { id: 'new', name: body.name ?? 'all', source: { version: '1.0.0' } },
  ],
  updated: unknown = { id: 'a1', name: 'QA test designer', source: { version: '1.1.0' } },
) {
  const requests: ApiRequest[] = [];
  const api: AdkApi = {
    request: vi.fn((request: ApiRequest) => {
      requests.push(request);
      if (request.path === '/agents/hub') return Promise.resolve(hub);
      if (request.path === '/agents/hub/install') {
        return Promise.resolve({
          agents: installed(request.body as { name?: string; plugin?: string }),
        });
      }
      return Promise.resolve({ agent: updated });
    }) as AdkApi['request'],
  };
  const said: string[] = [];
  const printed: string[] = [];
  const context = {
    say: (message: string) => said.push(message),
    print: (message: string) => printed.push(message),
    api: () => Promise.resolve(api),
  };
  return { requests, said, printed, context };
}

describe('devkit agents', () => {
  it('lists hub agents and plugin subagents with their install state', async () => {
    const { said, context } = setup();
    await runAgentsCommand([], {}, context);
    const text = said.join('\n');
    expect(text).toContain('↑ qa-test-designer');
    expect(text).toMatch(/ {3}technical-writer/);
    expect(text).toContain('Plugin jira-qa (Jira QA, acme · community · 2.0.0)');
    expect(text).toContain('✓ jira-reviewer');

    const filtered = setup();
    await runAgentsCommand(['writer'], {}, filtered.context);
    expect(filtered.said.join('\n')).not.toContain('qa-test-designer');
    await runAgentsCommand(['nothing-like-this'], {}, filtered.context);
    expect(filtered.said.at(-1)).toBe('No hub agent matches "nothing-like-this".');
  });

  it('prints the catalog as JSON', async () => {
    const { printed, context } = setup();
    await runAgentsCommand(['list'], { json: true }, context);
    expect(JSON.parse(printed[0]!)).toEqual(catalog);
  });

  it('installs hub agents by name and plugin subagents with --plugin', async () => {
    const { requests, said, context } = setup();
    await runAgentsCommand(['install', 'technical-writer'], {}, context);
    await runAgentsCommand(['install'], { plugin: 'jira-qa' }, context);
    await runAgentsCommand(['install', 'jira-reviewer'], { plugin: 'jira-qa' }, context);
    expect(requests.map((request) => request.body)).toEqual([
      { name: 'technical-writer' },
      { plugin: 'jira-qa' },
      { name: 'jira-reviewer', plugin: 'jira-qa' },
    ]);
    expect(said[0]).toBe(
      'Installed "technical-writer" (1.0.0) in the workspace. Find it on the Agents page.',
    );
    await expect(runAgentsCommand(['install'], {}, context)).rejects.toThrow(/Usage/);
  });

  it('updates what has a new version, all of it or by name', async () => {
    const { requests, said, context } = setup();
    await runAgentsCommand(['update'], {}, context);
    expect(
      requests.filter((request) => request.method === 'POST').map((request) => request.path),
    ).toEqual(['/agents/a1/hub-update']);
    expect(said.at(-1)).toBe('Updated "QA test designer" to 1.1.0.');

    await runAgentsCommand(['update', 'jira-qa/jira-reviewer'], {}, context);
    expect(said.at(-1)).toBe('Every agent installed from the ADK Hub is up to date.');
    await expect(runAgentsCommand(['update', 'technical-writer'], {}, context)).rejects.toThrow(
      /Not installed in this workspace: technical-writer/,
    );
    await expect(runAgentsCommand(['update', 'ghost'], {}, context)).rejects.toThrow(
      /Not in the ADK Hub: ghost/,
    );
  });

  it('explains an empty hub and lists plugins without a version by commit', async () => {
    const empty = setup({ ...catalog, agents: [], plugins: [] });
    await runAgentsCommand(['search'], {}, empty.context);
    expect(empty.said).toEqual(['The ADK Hub has no agents yet.']);

    const plugin = catalog.plugins[0]!;
    const unversioned = setup({
      ...catalog,
      agents: [],
      plugins: [
        { ...plugin, version: undefined, agents: [{ name: 'jira-triager', status: 'available' }] },
      ],
    });
    await runAgentsCommand([], {}, unversioned.context);
    const text = unversioned.said.join('\n');
    expect(text).toContain(`Plugin jira-qa (Jira QA, acme · community · ${'a'.repeat(12)})`);
    expect(text).toContain('  jira-triager');
    await expect(
      runAgentsCommand(['update', 'jira-qa/jira-triager'], {}, unversioned.context),
    ).rejects.toThrow(/Not installed in this workspace: jira-qa\/jira-triager/);
  });

  it('reports installs and updates as JSON or when nothing changed', async () => {
    const json = setup();
    await runAgentsCommand(['install', 'technical-writer'], { json: true }, json.context);
    await runAgentsCommand(['update'], { json: true }, json.context);
    expect(json.printed.map((line) => JSON.parse(line) as unknown)).toEqual([
      [{ id: 'new', name: 'technical-writer', source: { version: '1.0.0' } }],
      [{ id: 'a1', name: 'QA test designer', source: { version: '1.1.0' } }],
    ]);

    const nothing = setup(catalog, () => []);
    await runAgentsCommand(['install'], { plugin: 'jira-qa' }, nothing.context);
    expect(nothing.said).toEqual(['Every agent of jira-qa is already installed.']);

    const unversioned = setup(catalog, () => [{ id: 'x', name: 'local-copy' }], {
      id: 'a1',
      name: 'QA test designer',
    });
    await runAgentsCommand(['install', 'local-copy'], {}, unversioned.context);
    await runAgentsCommand(['update'], {}, unversioned.context);
    expect(unversioned.said).toEqual([
      'Installed "local-copy" () in the workspace. Find it on the Agents page.',
      'Updated "QA test designer" to the hub version.',
    ]);
  });
});
