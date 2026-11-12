import { describe, expect, it } from 'vitest';
import { WorkspaceSourceLoader } from '../src/modules/apitests/adapters/workspace-source-loader.js';
import { ApplicationError } from '../src/shared/errors.js';
import type { RequestContext } from '../src/shared/context.js';

const context: RequestContext = { requestId: 'r', ownerId: 'o', workspaceId: 'w' };

const plan = {
  id: 'p1',
  title: 'Login plan',
  suiteId: 's1',
  plans: [
    {
      title: 'Valid login',
      description: 'Happy path',
      steps: [
        { action: 'Open page', data: 'url', expectedResult: 'Page opens' },
        { action: 'Submit', data: '', expectedResult: 'Logged in' },
      ],
    },
    { title: 'Bare', description: '', steps: [] },
  ],
};

function build(overrides: Record<string, unknown> = {}) {
  const calls: unknown[][] = [];
  const options = {
    tests: {
      find: async (id: string, workspaceId: string) => {
        calls.push(['tests.find', id, workspaceId]);
        return id === 'p1' ? plan : null;
      },
      list: async () => [plan, { ...plan, id: 'p2', title: 'Other', suiteId: 'other' }],
    },
    suites: {
      find: async (id: string) =>
        id === 's1'
          ? { id: 's1', name: 'Auth suite' }
          : id === 'empty'
            ? { id: 'empty', name: 'Empty' }
            : null,
    },
    knowledge: {
      all: async () => [
        { pageId: 'page', chunkIndex: 1, source: 'wiki/My%20Page', content: 'second' },
        { pageId: 'page', chunkIndex: 0, source: 'wiki/My%20Page', content: 'first' },
        { pageId: 'bare', chunkIndex: 0, source: '', content: 'only' },
        { pageId: 'other', chunkIndex: 0, source: 'x', content: 'ignored' },
      ],
    },
    specs: {
      findSpecification: async (id: string) =>
        id === 'spec'
          ? {
              title: 'Spec',
              sections: [
                { title: 'Goal', content: ' Do it ' },
                { title: 'Empty', content: ' ' },
              ],
            }
          : null,
    },
    pbis: {
      get: async (_workspace: string, id: string) =>
        id === 'pbi'
          ? {
              id: 'pbi',
              kind: 'feature',
              title: 'Feature',
              status: 'Active',
              description: 'Details',
            }
          : id === 'plain'
            ? { id: 'plain', kind: 'bug', title: 'Plain', status: 'New', description: '' }
            : null,
      listChildren: async (_workspace: string, id: string) =>
        id === 'pbi' ? [{ kind: 'task', title: 'Child', description: 'Do' }] : [],
    },
    ...overrides,
  };
  return { loader: new WorkspaceSourceLoader(options as never), calls };
}

describe('WorkspaceSourceLoader', () => {
  it('renders a test plan as text', async () => {
    const { loader, calls } = build();
    const source = await loader.load(context, { type: 'testPlan', id: 'p1' });
    expect(source.title).toBe('Login plan');
    expect(source.text).toBe(
      [
        '### Test case 1: Valid login\nCase id: p1#0\nHappy path\n1. Open page (data: url) → Page opens\n2. Submit → Logged in',
        '### Test case 2: Bare\nCase id: p1#1',
      ].join('\n\n'),
    );
    expect(calls[0]).toEqual(['tests.find', 'p1', 'w']);
  });

  it('renders the plans of a suite, or says it is empty', async () => {
    const { loader } = build();
    const suite = await loader.load(context, { type: 'testSuite', id: 's1' });
    expect(suite.title).toBe('Auth suite');
    expect(suite.text).toContain('## Login plan\n\n### Test case 1');
    expect(suite.text).not.toContain('Other');
    expect((await loader.load(context, { type: 'testSuite', id: 'empty' })).text).toBe(
      '(empty suite)',
    );
  });

  it('joins the chunks of a knowledge page in order', async () => {
    const { loader } = build();
    const page = await loader.load(context, { type: 'brain', id: 'page' });
    expect(page).toMatchObject({ title: 'My Page', text: 'first\n\nsecond' });
    expect((await loader.load(context, { type: 'brain', id: 'bare' })).title).toBe('bare');
  });

  it('renders specifications and backlog items', async () => {
    const { loader } = build();
    expect((await loader.load(context, { type: 'spec', id: 'spec' })).text).toBe(
      '# Spec\n\n## Goal\n\nDo it\n',
    );
    const pbi = await loader.load(context, { type: 'pbi', id: 'pbi' });
    expect(pbi.text).toBe('FEATURE: Feature (Active)\n\nDetails\n\n- task: Child — Do');
    expect((await loader.load(context, { type: 'pbi', id: 'plain' })).text).toBe(
      'BUG: Plain (New)',
    );
  });

  it('fails with a not-found error for unknown sources and workspaces without ids', async () => {
    const { loader, calls } = build();
    for (const type of ['testPlan', 'testSuite', 'brain', 'spec', 'pbi'] as const) {
      const error = await loader
        .load(context, { type, id: 'nope' })
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ApplicationError);
      expect(error).toMatchObject({ code: 'API_TEST_SOURCE_NOT_FOUND', statusCode: 404 });
    }
    await expect(
      loader.load({ requestId: 'r', ownerId: 'o' }, { type: 'testPlan', id: 'p1' }),
    ).resolves.toBeTruthy();
    expect(calls.at(-1)).toEqual(['tests.find', 'p1', '']);
  });
});
