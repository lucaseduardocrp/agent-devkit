import { describe, expect, it, vi } from 'vitest';
import type { IntegrationDTO } from '../src/contracts/integrations.js';
import type { AgentRepository } from '../src/modules/agents/application/agent-repository.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';
import { EMPTY_AGENT_WORKFLOW } from '../src/modules/agents/domain/agent-workflow.js';
import { AgentE2eAuthor } from '../src/modules/e2e/application/e2e-author.js';
import type { E2eCreation } from '../src/modules/e2e/domain/e2e.js';
import { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';
import type { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';
import { AzureTestSuitePublisher } from '../src/modules/testplans/adapters/azure-test-suite-publisher.js';
import { AiKnowledgeTestPlanGenerator } from '../src/modules/testplans/application/generate-test-plan.js';

const enabledWorkflow = {
  ...EMPTY_AGENT_WORKFLOW,
  enabled: true,
  steps: [
    { id: 's1', name: 'Draft', instructions: 'Draft.' },
    { id: 's2', name: 'Review', instructions: 'Review.', agentId: 'workflow-agent' },
  ],
};

describe('DynamicProviderFactory.resolveMediaAuthorization', () => {
  function factory(entries: Partial<IntegrationDTO & { secret: string }>[]) {
    const service = {
      listIntegrations: async () =>
        entries.map((entry) => ({
          category: 'pbi',
          isEnabled: true,
          hasSecret: true,
          settings: {},
          ...entry,
        })),
      getDecryptedSecret: async (_owner: string, _category: string, providerId: string) =>
        entries.find((entry) => entry.providerId === providerId)?.secret ?? null,
    } as unknown as IntegrationsService;
    return new DynamicProviderFactory(service);
  }
  const resolve = (entries: Parameters<typeof factory>[0], url: string) =>
    factory(entries).resolveMediaAuthorization('owner', new URL(url));
  const basic = (value: string) => `Basic ${Buffer.from(value).toString('base64')}`;

  it('authorizes Azure DevOps files by organization, legacy host or base URL', async () => {
    const azure = {
      providerId: 'azure_devops',
      settings: { organization: 'Acme', baseUrl: 'https://tfs.acme.test' },
      secret: ' pat ',
    };
    await expect(resolve([azure], 'https://dev.azure.com/acme/_apis/x')).resolves.toEqual({
      authorization: basic(':pat'),
    });
    await expect(resolve([azure], 'https://acme.visualstudio.com/x')).resolves.not.toBeNull();
    await expect(
      resolve([{ ...azure, providerId: 'azure_devops_wiki' }], 'https://tfs.acme.test/x'),
    ).resolves.not.toBeNull();
    await expect(resolve([azure], 'https://dev.azure.com/other/x')).resolves.toBeNull();
    await expect(
      resolve([{ ...azure, settings: { baseUrl: 'not a url' } }], 'https://dev.azure.com/acme/x'),
    ).resolves.toBeNull();
    await expect(
      resolve([{ ...azure, secret: 'Bearer tok' }], 'https://dev.azure.com/acme/x'),
    ).resolves.toEqual({ authorization: 'Bearer tok' });
  });

  it('builds the header each provider expects', async () => {
    await expect(
      resolve(
        [
          {
            providerId: 'jira',
            settings: { baseUrl: 'https://acme.atlassian.net', email: 'qa@acme.test' },
            secret: 'tok',
          },
        ],
        'https://acme.atlassian.net/secure/a.png',
      ),
    ).resolves.toEqual({ authorization: basic('qa@acme.test:tok') });
    await expect(
      resolve([{ providerId: 'jira', settings: {} }], 'https://acme.atlassian.net/a.png'),
    ).resolves.toBeNull();
    await expect(
      resolve(
        [{ providerId: 'github_projects', secret: 'gh' }],
        'https://user-images.githubusercontent.com/a.png',
      ),
    ).resolves.toEqual({ authorization: 'Bearer gh' });
    await expect(
      resolve([{ providerId: 'github_projects', secret: 'gh' }], 'https://example.com/a.png'),
    ).resolves.toBeNull();
    await expect(
      resolve(
        [{ providerId: 'trello', settings: { apiKey: 'key' }, secret: 'tok' }],
        'https://trello.com/1/a.png',
      ),
    ).resolves.toEqual({ authorization: 'OAuth oauth_consumer_key="key", oauth_token="tok"' });
    await expect(
      resolve([{ providerId: 'trello', secret: 'tok' }], 'https://example.com/a.png'),
    ).resolves.toBeNull();
    await expect(
      resolve(
        [{ providerId: 'wiki_js', settings: { baseUrl: 'https://wiki.test' }, secret: 'w' }],
        'https://wiki.test/a.png',
      ),
    ).resolves.toEqual({ authorization: 'Bearer w' });
    await expect(
      resolve([{ providerId: 'wiki_js', settings: {} }], 'https://wiki.test/a.png'),
    ).resolves.toBeNull();
  });

  it('skips disabled, secretless, unknown and blank-secret integrations', async () => {
    await expect(
      resolve(
        [
          { providerId: 'github_projects', isEnabled: false, secret: 'x' },
          { providerId: 'github_projects', hasSecret: false },
          { providerId: 'slack', secret: 'x' },
          { providerId: 'trello', secret: ' ' },
        ],
        'https://trello.com/',
      ),
    ).resolves.toBeNull();
    await expect(resolve([], 'https://dev.azure.com')).resolves.toBeNull();
  });
});

describe('AiKnowledgeTestPlanGenerator with an agent workflow', () => {
  const requirement = 'The report screen must list dismissals between two dates.';
  const plansJson = JSON.stringify([
    {
      title: 'Report filter',
      description: 'Filter the report',
      steps: [{ action: 'Open the report screen.', expected: 'The report screen is displayed.' }],
    },
  ]);

  function generator(
    results: string[],
    agents: { id: string; isDefault?: boolean; role?: string }[] = [],
    workflow: typeof enabledWorkflow | typeof EMPTY_AGENT_WORKFLOW = enabledWorkflow,
  ) {
    const executeAgent = vi.fn();
    for (const result of results) executeAgent.mockResolvedValueOnce({ result });
    const agentService = {
      getWorkflow: vi.fn().mockResolvedValue(workflow),
      executeAgent,
    } as unknown as AgentService;
    const agentRepository = {
      listByWorkspace: vi.fn().mockResolvedValue(agents),
      findById: vi.fn(async (id: string) => ({ id, instructions: 'Agent.' })),
    } as unknown as AgentRepository;
    return {
      executeAgent,
      subject: new AiKnowledgeTestPlanGenerator({ agentService, agentRepository }),
    };
  }
  const context = { requestId: 'r', ownerId: 'owner', workspaceId: 'ws' };

  it('runs the workflow with the default agent and retries invalid output', async () => {
    const { subject, executeAgent } = generator(
      ['not json', plansJson],
      [
        { id: 'qa', role: 'QA' },
        { id: 'default', isDefault: true },
      ],
    );
    const result = await subject.generate({ prompt: requirement, llmProvider: 'openai' }, context);
    expect(result.title).toBe('Report filter');
    expect(executeAgent).toHaveBeenCalledTimes(2);
    expect(executeAgent.mock.calls[0]![1]).toBe('default');
    expect(executeAgent.mock.calls[0]![2]).toMatchObject({
      includeKnowledge: false,
      llmProvider: 'openai',
    });
    expect(executeAgent.mock.calls[1]![2].prompt).toContain('CORRECTION REQUIRED');
  });

  it('picks the request agent, then a QA agent, then the workflow agent', async () => {
    const chosen = async (agents: { id: string; role?: string }[], agentId?: string) => {
      const { subject, executeAgent } = generator([plansJson], agents);
      await subject.generate({ prompt: requirement, ...(agentId ? { agentId } : {}) }, context);
      return executeAgent.mock.calls[0]![1] as string;
    };
    expect(await chosen([{ id: 'qa', role: 'QA' }], 'picked')).toBe('picked');
    expect(await chosen([{ id: 'x' }, { id: 'qa', role: 'QA' }])).toBe('qa');
    expect(await chosen([{ id: 'x' }])).toBe('workflow-agent');
  });

  it('fails without an agent or with output that never becomes valid', async () => {
    const noAgent = generator([], [], {
      ...enabledWorkflow,
      steps: [{ id: 's1', name: 'Draft', instructions: 'Draft.' }],
    });
    await expect(noAgent.subject.generate({ prompt: requirement }, context)).rejects.toMatchObject({
      code: 'AGENT_WORKFLOW_AGENT_REQUIRED',
      statusCode: 409,
    });
    const invalid = generator(['[]', '[]'], [{ id: 'a', isDefault: true }]);
    await expect(
      invalid.subject.generate({ prompt: requirement }, { requestId: 'r', ownerId: 'owner' }),
    ).rejects.toMatchObject({ code: 'AGENT_WORKFLOW_OUTPUT_INVALID', statusCode: 502 });
  });
});

describe('AzureTestSuitePublisher work item edge cases', () => {
  const tree = {
    id: 'local',
    name: 'Regression',
    cases: [
      {
        title: 'Login',
        description: 'Session',
        steps: [{ action: 'Open', expectedResult: 'Form' }],
        metadata: { caseId: 'c1', remoteCaseIds: { azure_devops: '7' } },
      },
    ],
    children: [],
  };

  function azure(routes: { item?: () => Response; categories?: unknown }) {
    const calls: string[] = [];
    const reply = (data: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => data }) as Response;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/wit/workitems/50?')) return routes.item?.() ?? reply({});
      if (url.includes('/wit/workitemtypecategories')) return reply(routes.categories ?? {});
      if (url.includes('/wit/workitems/7?') && url.includes('relations')) return reply({});
      if (url.endsWith('/testplan/plans?api-version=7.1')) return reply({ id: 10 });
      if (url.includes('/testplan/plans/10?')) return reply({ id: 10, rootSuite: { id: 11 } });
      if (url.includes('/testplan/Plans/10/suites?')) return reply({ id: 20 });
      if (url.includes('/wit/workitems/')) return reply({ id: 7 });
      return reply({});
    });
    return {
      calls,
      publisher: new AzureTestSuitePublisher('https://dev.azure.com/org', 'QA', 'pat', fetcher),
    };
  }

  it('rethrows work item failures other than missing items', async () => {
    const { publisher } = azure({
      item: () => ({ ok: false, status: 500, json: async () => ({}) }) as Response,
    });
    await expect(publisher.publish(tree, { workItemIds: ['50'] })).rejects.toMatchObject({
      code: 'TEST_SUITE_PUBLISH_FAILED',
    });
  });

  it('names untyped work items and rejects them when no category accepts them', async () => {
    const empty = azure({});
    await expect(
      empty.publisher.publish(tree, { suiteKind: 'requirement', workItemIds: ['50'] }),
    ).rejects.toMatchObject({
      code: 'REQUIREMENT_SUITE_REJECTED',
      messageParams: { id: 50, type: 'Work Item' },
    });

    const partial = azure({
      categories: { value: [{}, { referenceName: 'Microsoft.BugCategory' }] },
    });
    await expect(
      partial.publisher.publish(tree, { suiteKind: 'requirement', workItemIds: ['50'] }),
    ).rejects.toMatchObject({ code: 'REQUIREMENT_SUITE_REJECTED' });
  });

  it('links an existing case that has no relations yet', async () => {
    const { publisher, calls } = azure({});
    const result = await publisher.publish(tree, { workItemIds: ['50'] });
    expect(
      calls.some((url) => url.includes('/wit/workitems/7?') && url.includes('relations')),
    ).toBe(true);
    expect(result.workItems).toEqual([{ id: '50', type: 'Work Item', title: '' }]);
  });
});

describe('AgentE2eAuthor with an agent workflow', () => {
  it('runs the workspace workflow instead of calling the model directly', async () => {
    const executeAgent = vi
      .fn()
      .mockResolvedValue({ result: '{"verdict":"test_issue","summary":"s"}' });
    const agents = {
      getAgent: vi.fn().mockResolvedValue({ id: 'agent-1', instructions: 'QA', model: null }),
      getWorkflow: vi.fn().mockResolvedValue(enabledWorkflow),
      executeAgent,
    } as unknown as AgentService;
    const creation = {
      id: 'c1',
      workspaceId: 'ws',
      ownerId: 'owner',
      agentId: 'agent-1',
      mode: 'frontend',
      baseUrl: 'http://localhost:3000',
      localOrigin: null,
      path: '/',
    } as unknown as E2eCreation;

    const analysis = await new AgentE2eAuthor({ agents }).analyze({
      creation,
      test: { code: 'TC1', title: 't', description: 'd', steps: ['open'] },
      script: 'test()',
      error: 'boom',
      logs: 'log',
    } as never);

    expect(analysis).toEqual({ verdict: 'test_issue', summary: 's' });
    expect(executeAgent).toHaveBeenCalledWith(
      'ws',
      'agent-1',
      expect.objectContaining({ includeKnowledge: false }),
      { requestId: 'e2e-agent-c1', workspaceId: 'ws', ownerId: 'owner' },
      undefined,
    );
    expect(executeAgent.mock.calls[0]![2].prompt).toContain('E2E task context:');
  });
});
