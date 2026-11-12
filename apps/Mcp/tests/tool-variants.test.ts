import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/core/registry.js';
import type { ToolResult } from '../src/core/tool.js';
import { MAX_ATTACHMENT_BYTES, readAttachmentBytes } from '../src/modules/issues/attach-file.js';
import { modules } from '../src/modules/index.js';
import { fakeContext, fixtures } from './support/fake-api.js';

const registry = new ToolRegistry(modules);

async function call(name: string, input: unknown, setup = fakeContext()) {
  const tool = registry.find(name);
  if (!tool) throw new Error(`Unknown tool ${name}`);
  const result = await tool.execute(input, setup.context);
  return { ...setup, result, data: (result as Extract<ToolResult, { kind: 'json' }>).data as any };
}

const UUID_A = '33333333-3333-4333-8333-333333333333';
const UUID_B = '44444444-4444-4444-8444-444444444444';
const workItem = (overrides: Record<string, unknown>) => ({
  id: UUID_A,
  parentId: null,
  kind: 'card',
  title: 'Untitled',
  description: '',
  status: 'New',
  sourceData: {},
  links: [],
  ...overrides,
});
const createRun = {
  name: 'Checkout',
  agentId: 'a1',
  baseUrl: 'https://shop.test',
  prd: 'Pay with card.',
  repository: { provider: 'github', id: '42', branch: 'main' },
};

describe('API test and load tools', () => {
  it('creates and replaces collections, environments and load scenarios', async () => {
    const replaced = await call('integration_save_collection', {
      collectionId: 'c1',
      collection: { name: 'API' },
    });
    expect(replaced.api.calls[0]).toMatchObject({
      method: 'PUT',
      path: '/integration-tests/collections/c1',
    });
    const created = await call('integration_save_environment', { name: 'Staging' });
    expect(created.api.calls[0]).toMatchObject({
      method: 'POST',
      path: '/integration-tests/environments',
      body: { name: 'Staging', variables: [] },
    });
    const scenario = await call('load_save_scenario', { scenario: { name: 'Peak' } });
    expect(scenario.api.calls[0]).toMatchObject({ method: 'POST', path: '/load-tests/scenarios' });
    const edited = await call('load_save_scenario', { scenarioId: 's1', scenario: {} });
    expect(edited.api.calls[0]).toMatchObject({ method: 'PUT', path: '/load-tests/scenarios/s1' });
  });

  it('exports with the chosen environments, and as files only for Bruno', async () => {
    const bruno = await call('integration_export', {
      collectionId: 'c1',
      format: 'bruno',
      environmentIds: ['e1', 'e2'],
    });
    expect(bruno.api.calls[0]!.query).toEqual({
      format: 'bruno',
      environmentIds: 'e1,e2',
      as: 'files',
    });
    const postman = await call('integration_export', { collectionId: 'c1' });
    expect(postman.api.calls[0]!.query).toEqual({ format: 'postman' });
  });

  it('filters API and load runs only when asked to', async () => {
    const all = await call('integration_list_runs', {});
    expect(all.api.calls[0]!.query).toEqual({ limit: '20' });
    const one = await call('integration_list_runs', { collectionId: 'c1', limit: 5 });
    expect(one.api.calls[0]!.query).toEqual({ limit: '5', collectionId: 'c1' });
    const loads = await call('load_list_runs', {});
    expect(loads.api.calls[0]!.query).toEqual({ limit: '20' });
  });
});

describe('account, workspace and Brain tools', () => {
  it('reports no active workspace as null', async () => {
    const setup = fakeContext({ token: 't' });
    expect((await call('auth_whoami', {}, setup)).data.activeWorkspaceId).toBeNull();
    expect((await call('workspaces_list', {}, setup)).data.activeWorkspaceId).toBeNull();
  });

  it('edits a permission group when its id is given', async () => {
    const { api } = await call('workspaces_save_group', {
      workspaceId: 'ws-1',
      groupId: 'g1',
      name: 'QA',
    });
    expect(api.calls[0]).toMatchObject({ method: 'PATCH', path: '/workspaces/ws-1/groups/g1' });
  });

  it('finds a Brain document of one source among pages with the same id', async () => {
    const { data } = await call('brain_get_document', {
      pageId: 'doc-1',
      source: 'app://local?title=Checkout',
    });
    expect(data.title).toBe('Checkout rules');
    await expect(
      call('brain_get_document', { pageId: 'doc-1', source: 'https://other.test' }),
    ).rejects.toThrow('not found');
  });
});

describe('spec tools without template, agent or Brain sources', () => {
  const bare = () => {
    const setup = fakeContext();
    setup.api.on('GET /spec/specifications', () => [
      { id: 's9', title: 'Bare', sections: [], messages: [], updatedAt: 'now' },
    ]);
    return setup;
  };

  it('lists specifications that have no template, agent or parent', async () => {
    const { data } = await call('spec_list', {}, bare());
    expect(data).toEqual([
      {
        id: 's9',
        title: 'Bare',
        parentId: null,
        templateId: null,
        agentId: null,
        sections: 0,
        filledSections: 0,
        messages: 0,
        updatedAt: 'now',
      },
    ]);
  });

  it('prepares chat for a spec without agent, skipping the Brain search when asked', async () => {
    const { data, api } = await call(
      'spec_prepare_chat',
      { specId: 's9', content: 'Hello', knowledgeLimit: 0 },
      bare(),
    );
    expect(data).toMatchObject({ agentId: null, agentInstructions: null, knowledge: null });
    expect(api.calls.some((request) => request.path.startsWith('/agents/a'))).toBe(false);
    expect(api.calls.some((request) => request.path === '/TestPlan/search')).toBe(false);
  });
});

describe('release note tools', () => {
  it('resolves work item numbers to ids when saving', async () => {
    const created = await call('release_notes_create', { title: 'R', itemIds: ['50086'] });
    expect(created.api.calls.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /pbi/items/50086',
      'POST /release-notes',
    ]);
    expect((created.api.calls[1]!.body as { itemIds: string[] }).itemIds).toEqual([
      '22222222-2222-4222-8222-222222222222',
    ]);
    const updated = await call('release_notes_update', {
      releaseNoteId: 'rn1',
      itemIds: ['50086', '50086'],
    });
    expect((updated.api.calls[1]!.body as { itemIds: string[] }).itemIds).toEqual([
      '22222222-2222-4222-8222-222222222222',
    ]);
  });

  it('describes items of every kind, with or without parent, link and description', async () => {
    const setup = fakeContext();
    setup.api.on('GET /pbi/items/a', () => ({
      item: workItem({ id: UUID_A, kind: 'pbi', title: 'Epic work' }),
    }));
    setup.api.on('GET /pbi/items/b', () => ({
      item: workItem({
        id: UUID_B,
        parentId: UUID_A,
        title: 'Long one',
        description: `<p>${'word '.repeat(400)}</p>`,
        sourceData: { adkCardType: 'Spike' },
        links: [{ providerId: 'azure_devops', externalId: '77' }],
      }),
    }));
    const { data, api } = await call(
      'release_notes_prepare',
      { title: 'R', itemIds: ['a', 'b'], knowledgeLimit: 0 },
      setup,
    );
    expect(data.items).toContain('[PBI] Epic work (New)');
    expect(data.items).toContain('[Spike] #77 Long one (New)');
    expect(data.items).toContain('Parent: Epic work');
    expect(data.items).toContain('…');
    expect(data).toMatchObject({ knowledge: null, instructions: null, version: null });
    expect(api.calls.some((request) => request.path === '/TestPlan/search')).toBe(false);

    const plain = fakeContext();
    plain.api.on('GET /pbi/items/c', () => ({ item: workItem({ id: UUID_B, title: 'Small' }) }));
    const card = await call('release_notes_prepare', { title: 'R', itemIds: ['c'] }, plain);
    expect(card.data.items).toContain('[Card] Small (New)');
  });
});

describe('E2E tools', () => {
  it('rejects localhost for an explicit remote target and lets unparsable URLs through', async () => {
    await expect(
      call('e2e_create', {
        ...createRun,
        baseUrl: 'http://localhost:3000',
        executionTarget: 'remote',
      }),
    ).rejects.toThrow('e2e_tunnel_setup');
    const { api } = await call('e2e_create', { ...createRun, baseUrl: 'not a url' });
    expect(api.calls.map((request) => request.path)).toEqual(['/e2e/creations']);
    expect((api.calls[0]!.body as { baseUrl: string }).baseUrl).toBe('not a url');
  });

  it('briefs a run whose API sends no existing tests, and linked tests without steps', async () => {
    const bare = fakeContext();
    const { existingTests: _existing, ...brief } = fixtures.e2eBrief;
    bare.api.on('POST /e2e/creations/c1/brief', () => ({ brief }));
    expect((await call('e2e_prepare', { runId: 'c1' }, bare)).data.existingTests).toEqual([]);

    const linked = fakeContext();
    linked.api.on('POST /e2e/creations/c1/brief', () => ({
      brief: {
        ...fixtures.e2eBrief,
        existingTests: [{ code: 'TC001', title: 'Linked', externalCase: fixtures.externalCase }],
      },
    }));
    const [test] = (await call('e2e_prepare', { runId: 'c1' }, linked)).data.existingTests;
    expect(test.steps).toContain('<untrusted-content');
  });
});

describe('workflow prompts', () => {
  const render = (name: string, args: Record<string, string | undefined>) =>
    registry.prompts.find((prompt) => prompt.name === name)!.render(args);

  it('renders every prompt with and without its optional arguments', () => {
    expect(render('ask_brain', { question: 'How to pay?' })).toContain('Question: How to pay?');
    expect(render('create_prototype', { request: 'Login' })).toContain('design_list_providers');
    expect(render('create_prototype', { request: 'Login', provider: 'github' })).toContain(
      'Use the "github" repository.',
    );
    expect(render('draft_spec', { request: 'Checkout' })).not.toContain('specId');
    expect(render('draft_spec', { request: 'Checkout', specId: 's1' })).toContain('specId "s1"');
    expect(render('generate_test_plan', { requirement: 'Pay' })).not.toContain('Criteria:');
    expect(render('generate_test_plan', { requirement: 'Pay', criteria: 'Fast' })).toContain(
      'Criteria:\nFast',
    );
  });
});

describe('attachment size limits', () => {
  const local = () => ({ allowLocalFiles: true });

  it('refuses a local file over the limit before reading it, and an empty one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adk-attach-size-'));
    try {
      const big = join(dir, 'big.bin');
      await writeFile(big, '');
      await truncate(big, MAX_ATTACHMENT_BYTES + 1);
      await expect(
        readAttachmentBytes({ issueId: 'i1', name: 'big.bin', filePath: big }, local()),
      ).rejects.toThrow('larger than 100 MB');
      const empty = join(dir, 'empty.txt');
      await writeFile(empty, '');
      await expect(
        readAttachmentBytes({ issueId: 'i1', name: 'empty.txt', filePath: empty }, local()),
      ).rejects.toThrow('The file is empty.');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses inline content over the limit', async () => {
    await expect(
      readAttachmentBytes(
        { issueId: 'i1', name: 'a.txt', text: 'a'.repeat(MAX_ATTACHMENT_BYTES + 1) },
        {},
      ),
    ).rejects.toThrow('larger than 100 MB');
  });
});
