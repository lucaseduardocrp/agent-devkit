import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/core/registry.js';
import type { ToolResult } from '../src/core/tool.js';
import { modules } from '../src/modules/index.js';
import { fakeContext, fixtures } from './support/fake-api.js';

/** Optional inputs and alternative backend answers the contract cases in tools.test.ts skip. */
const registry = new ToolRegistry(modules);

async function call(name: string, input: unknown, setup = fakeContext()) {
  const result = await registry.find(name)!.execute(input, setup.context);
  return { ...setup, data: (result as Extract<ToolResult, { kind: 'json' }>).data as any };
}

const lastCall = (setup: ReturnType<typeof fakeContext>) =>
  setup.api.calls[setup.api.calls.length - 1]!;

describe('prompts', () => {
  it('renders every prompt with and without its optional arguments', () => {
    const rendered = (name: string, args: Record<string, string | undefined>) =>
      registry.prompts.find((prompt) => prompt.name === name)!.render(args);
    expect(rendered('ask_brain', { question: 'Refunds?' })).toContain('Question: Refunds?');
    expect(rendered('create_prototype', { request: 'Login' })).toContain('design_list_providers');
    expect(rendered('create_prototype', { request: 'Login', provider: 'github' })).toContain(
      'Use the "github" repository.',
    );
    expect(rendered('draft_spec', { request: 'Checkout' })).not.toContain('specId');
    expect(rendered('draft_spec', { request: 'Checkout', specId: 's1' })).toContain('specId "s1"');
    expect(rendered('generate_test_plan', { requirement: 'Pay' })).not.toContain('Criteria');
    expect(rendered('generate_test_plan', { requirement: 'Pay', criteria: 'Card' })).toContain(
      'Criteria:\nCard',
    );
  });
});

describe('workflow brief', () => {
  it('turns every workflow setting into a rule for the host model', async () => {
    const setup = fakeContext();
    setup.api.on('GET /agents/workflow', () => ({
      workflow: {
        ...fixtures.workflow,
        enabled: true,
        autonomy: 'supervised',
        finalReview: false,
        uncertaintyBehavior: 'assume',
        issueCreationBehavior: 'create',
        defaultAction: 'deny',
        steps: [
          { name: 'Plan', reviewRequired: true },
          { name: 'Build', reviewRequired: false },
        ],
        rules: [
          { id: 'd', name: 'D', toolset: 'design', effect: 'deny' },
          {
            id: 'a',
            name: 'A',
            toolset: 'pbi',
            toolName: 'pbi_push',
            effect: 'allow',
            allowedProviders: ['github'],
            createIssueForAction: true,
            requireApproval: true,
          },
          { id: 'p', name: 'Plain', toolset: 'spec', effect: 'allow' },
        ],
      },
    }));
    const { data } = await call('agents_prepare_run', { agentId: 'a1', prompt: 'Go' }, setup);
    expect(data.rule).toContain('Never skip a step.');
    expect(data.rule).toContain('Ask the user to approve each completed workflow step');
    expect(data.rule).toContain('wait for approval: Plan.');
    expect(data.rule).toContain('Use conservative assumptions');
    expect(data.rule).toContain('only when it is part of the user');
    expect(data.rule).toContain('disabled final approval');
    expect(data.rule).toContain('Block every write action');
    expect(data.rule).toContain('Never call module design.');
    expect(data.rule).toContain('For tool pbi_push, use only these providers: github.');
    expect(data.rule).toContain('A tracking Issue is created automatically');
    expect(data.rule).toContain('requests user approval before each write action on tool pbi_push');

    const autonomous = fakeContext();
    autonomous.api.on('GET /agents/workflow', () => ({
      workflow: { ...fixtures.workflow, enabled: true, autonomy: 'autonomous' },
    }));
    const brief = (await call('agents_prepare_run', { agentId: 'a1', prompt: 'Go' }, autonomous))
      .data;
    expect(brief.rule).toContain('without asking for routine approvals');
  });
});

describe('API and load test tools', () => {
  it('creates collections, environments and scenarios when no id is given', async () => {
    const setup = fakeContext();
    await call('integration_save_collection', { collection: { name: 'API' } }, setup);
    await call('integration_save_environment', { name: 'Dev' }, setup);
    await call('load_save_scenario', { scenario: { name: 'Peak' } }, setup);
    expect(setup.api.calls.map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /integration-tests/collections',
      'POST /integration-tests/environments',
      'POST /load-tests/scenarios',
    ]);
  });

  it('updates a collection by id', async () => {
    const setup = fakeContext();
    await call('integration_save_collection', { collectionId: 'c1', collection: {} }, setup);
    expect(lastCall(setup)).toMatchObject({
      method: 'PUT',
      path: '/integration-tests/collections/c1',
    });
  });

  it('forwards export environments and run filters only when given', async () => {
    const setup = fakeContext();
    await call('integration_export', { collectionId: 'c1', environmentIds: ['e1', 'e2'] }, setup);
    expect(lastCall(setup).query).toEqual({ format: 'postman', environmentIds: 'e1,e2' });
    await call('integration_list_runs', { collectionId: 'c1', limit: 5 }, setup);
    expect(lastCall(setup).query).toEqual({ limit: '5', collectionId: 'c1' });
    await call('load_list_runs', {}, setup);
    expect(lastCall(setup).query).toEqual({ limit: '20' });
  });
});

describe('release note briefs', () => {
  const item = (id: string, overrides: Record<string, unknown>) => ({
    item: {
      id,
      parentId: null,
      kind: 'card',
      title: `Item ${id}`,
      description: '',
      status: 'New',
      sourceData: {},
      links: [],
      ...overrides,
    },
  });
  const uuid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

  it('labels item types, includes known parents and truncates long descriptions', async () => {
    const setup = fakeContext();
    setup.api.on(`GET /pbi/items/${uuid(1)}`, () =>
      item(uuid(1), { sourceData: { adkCardType: 'Story' }, description: 'x'.repeat(5_000) }),
    );
    setup.api.on(`GET /pbi/items/${uuid(2)}`, () => item(uuid(2), { parentId: uuid(1) }));
    setup.api.on(`GET /pbi/items/${uuid(3)}`, () =>
      item(uuid(3), { kind: 'pbi', sourceData: { type: 7 } }),
    );
    const { data } = await call(
      'release_notes_prepare',
      { title: 'R', version: '2.0', itemIds: [uuid(1), uuid(2), uuid(3)], knowledgeLimit: 0 },
      setup,
    );
    expect(data.items).toContain(`[Story] Item ${uuid(1)} (New)`);
    expect(data.items).toContain('…');
    expect(data.items).toContain(`[Card] Item ${uuid(2)} (New)\nParent: Item ${uuid(1)}`);
    expect(data.items).toContain(`[PBI] Item ${uuid(3)} (New)`);
    expect(data.version).toBe('2.0');
    expect(data.agentInstructions).toBeNull();
    expect(data.knowledge).toBeNull();
    expect(setup.api.calls.some((request) => request.path === '/TestPlan/search')).toBe(false);
  });
});

describe('specification variants', () => {
  it('lists specs without optional links and chats without an agent or knowledge', async () => {
    const setup = fakeContext();
    const { agentId: _agentId, templateId: _templateId, ...bare } = fixtures.specs[0];
    setup.api.on('GET /spec/specifications', () => [bare]);
    const [listed] = (await call('spec_list', {}, setup)).data;
    expect(listed).toMatchObject({ parentId: null, templateId: null, agentId: null });

    const { data } = await call(
      'spec_prepare_chat',
      { specId: 's1', content: 'Errors?', knowledgeLimit: 0 },
      setup,
    );
    expect(data).toMatchObject({ agentId: null, agentInstructions: null, knowledge: null });
    expect(setup.api.calls.some((request) => request.path.startsWith('/agents/a'))).toBe(false);
  });
});

describe('session and workspace variants', () => {
  it('reports no active workspace and creates groups when no id is given', async () => {
    const setup = fakeContext({ token: 't' });
    expect((await call('workspaces_list', {}, setup)).data.activeWorkspaceId).toBeNull();
    expect((await call('auth_whoami', {}, setup)).data.activeWorkspaceId).toBeNull();
    await call('workspaces_save_group', { workspaceId: 'ws-2', name: 'QA' }, setup);
    expect(lastCall(setup)).toMatchObject({ method: 'POST', path: '/workspaces/ws-2/groups' });
    await call('workspaces_save_group', { workspaceId: 'ws-2', groupId: 'g1', name: 'QA' }, setup);
    expect(lastCall(setup)).toMatchObject({ method: 'PATCH', path: '/workspaces/ws-2/groups/g1' });
  });

  it('finds Brain documents by source', async () => {
    const { data } = await call('brain_get_document', {
      pageId: 'w-1',
      source: 'https://dev.azure.com/wiki',
    });
    expect(data.title).toBe('Refunds');
    await expect(
      call('brain_get_document', { pageId: 'w-1', source: 'app://other' }),
    ).rejects.toThrow('not found');
  });
});

describe('E2E variants', () => {
  it('passes base URLs that are not absolute through for the backend to validate', async () => {
    const setup = fakeContext();
    await call(
      'e2e_create',
      {
        name: 'Shop',
        agentId: 'a1',
        baseUrl: 'shop.test',
        prd: 'Pay.',
        repository: { provider: 'github', id: '42', branch: 'main' },
      },
      setup,
    );
    expect(lastCall(setup).body).toMatchObject({ baseUrl: 'shop.test' });
  });

  it('briefs runs without existing tests and linked tests without steps', async () => {
    const setup = fakeContext();
    const { existingTests: _existing, ...brief } = fixtures.e2eBrief;
    setup.api.on('POST /e2e/creations/c1/brief', () => ({ brief }));
    expect((await call('e2e_prepare', { runId: 'c1' }, setup)).data.existingTests).toEqual([]);

    setup.api.on('GET /e2e/tests/t1', () => ({
      test: {
        id: 't1',
        error: null,
        logs: null,
        analysis: null,
        externalCase: fixtures.externalCase,
      },
    }));
    const { data } = await call('e2e_get_test', { testId: 't1' }, setup);
    expect(data.test.steps).toContain(':steps');
  });
});
