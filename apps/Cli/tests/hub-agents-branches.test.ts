import { describe, expect, it, vi } from 'vitest';
import type { AdkApi, ApiRequest, HubAgentCatalogDto } from '#mcp';
import { runAgentsCommand } from '../src/hub/agents-command.js';

const plugin = (overrides: Record<string, unknown> = {}) => ({
  name: 'jira-qa',
  title: 'Jira QA',
  description: 'Jira agents.',
  maintainer: 'acme',
  tier: 'community',
  license: 'MIT',
  repo: 'https://github.com/acme/adk-jira',
  sha: 'abcdef0123456789'.repeat(2),
  agents: [{ name: 'jira-reviewer', status: 'available' }],
  ...overrides,
});

function catalogOf(plugins: unknown[], agents: unknown[] = []): HubAgentCatalogDto {
  return {
    generatedAt: '2026-10-23T12:00:00Z',
    categories: [],
    agents,
    plugins,
  } as unknown as HubAgentCatalogDto;
}

function setup(catalog: HubAgentCatalogDto, answers: Record<string, unknown> = {}) {
  const requests: ApiRequest[] = [];
  const api: AdkApi = {
    request: vi.fn((request: ApiRequest) => {
      requests.push(request);
      if (request.path === '/agents/hub') return Promise.resolve(catalog);
      return Promise.resolve(answers[request.path]);
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

describe('devkit agents branches', () => {
  it('says so when the hub has no agents at all', async () => {
    const { said, context } = setup(catalogOf([]));
    await runAgentsCommand([], {}, context);
    expect(said).toEqual(['The ADK Hub has no agents yet.']);
  });

  it('shows the commit of a plugin that has no version', async () => {
    const { said, context } = setup(catalogOf([plugin()]));
    await runAgentsCommand([], {}, context);
    expect(said[0]).toContain('community · abcdef012345)');
  });

  it('prints installed agents as JSON, and says when a plugin has nothing left to install', async () => {
    const answers = { '/agents/hub/install': { agents: [{ id: 'n', name: 'Reviewer' }] } };
    const json = setup(catalogOf([plugin()]), answers);
    await runAgentsCommand(
      ['install', 'jira-reviewer'],
      { json: true, plugin: 'jira-qa' },
      json.context,
    );
    expect(JSON.parse(json.printed[0]!)).toEqual([{ id: 'n', name: 'Reviewer' }]);

    const none = setup(catalogOf([plugin()]), { '/agents/hub/install': { agents: [] } });
    await runAgentsCommand(['install'], { plugin: 'jira-qa' }, none.context);
    expect(none.said).toEqual(['Every agent of jira-qa is already installed.']);

    const noVersion = setup(catalogOf([plugin()]), answers);
    await runAgentsCommand(['install', 'jira-reviewer'], { plugin: 'jira-qa' }, noVersion.context);
    expect(noVersion.said[0]).toBe(
      'Installed "Reviewer" () in the workspace. Find it on the Agents page.',
    );
  });

  it('prints updates as JSON and names updates that carry no version', async () => {
    const catalog = catalogOf([
      plugin({
        agents: [
          {
            name: 'jira-reviewer',
            status: 'update-available',
            installed: { agentId: 'p1', name: 'Jira reviewer', version: '1.0.0' },
          },
          { name: 'jira-triage', status: 'available' },
        ],
      }),
    ]);
    const answers = { '/agents/p1/hub-update': { agent: { id: 'p1', name: 'Jira reviewer' } } };
    const json = setup(catalog, answers);
    await runAgentsCommand(['update'], { json: true }, json.context);
    expect(JSON.parse(json.printed[0]!)).toEqual([{ id: 'p1', name: 'Jira reviewer' }]);

    const text = setup(catalog, answers);
    await runAgentsCommand(['update', 'jira-qa/jira-reviewer'], {}, text.context);
    expect(text.said).toEqual(['Updated "Jira reviewer" to the hub version.']);
  });
});
