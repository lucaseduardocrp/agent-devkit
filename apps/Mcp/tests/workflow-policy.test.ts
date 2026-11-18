import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ApiRequest } from '../src/api/http-client.js';
import { executeWithWorkflowPolicy } from '../src/core/workflow-policy.js';
import { defineTool, json, text, type McpTool, type ToolAccess } from '../src/core/tool.js';
import { fakeContext, fixtures } from './support/fake-api.js';

interface Rule {
  id?: string;
  name?: string;
  toolset: string;
  toolName?: string;
  effect: 'allow' | 'deny';
  allowedProviders?: string[];
  createIssueForAction?: boolean;
  requireApproval?: boolean;
}

function rule(overrides: Rule) {
  return { id: 'r', name: 'Rule', ...overrides };
}

/** A context whose workspace has the given workflow policy. */
function policy(
  workflow: Record<string, unknown> = {},
  state: Parameters<typeof fakeContext>[0] = { token: 't', workspaceId: 'ws-1' },
) {
  const setup = fakeContext(state);
  setup.api.on('GET /agents/workflow', () => ({ workflow: { ...fixtures.workflow, ...workflow } }));
  return setup;
}

function tool(
  name: string,
  access: ToolAccess,
  toolset: McpTool['toolset'] = 'brain',
  result = json({ done: true }),
) {
  const calls: unknown[] = [];
  const spec = defineTool({
    name,
    title: `Title of ${name}`,
    description: 'A tool',
    toolset,
    access,
    routes: [],
    input: {
      provider: z.string().optional(),
      note: z.string().optional(),
      token: z.string().optional(),
    },
    run: async (input) => {
      calls.push(input);
      return result;
    },
  });
  return { spec, calls };
}

const run = (spec: McpTool, input: unknown, context: ReturnType<typeof fakeContext>['context']) =>
  executeWithWorkflowPolicy(spec, input, context);

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: Error & { code?: string }) => error,
  );

describe('workflow policy: when it applies', () => {
  it('runs the tool as is when the session has no workspace', async () => {
    const { context, api } = policy({ defaultAction: 'deny' }, { token: 't' });
    const { spec, calls } = tool('brain_write', 'write');
    await run(spec, {}, context);
    expect(calls).toHaveLength(1);
    expect(api.calls).toHaveLength(0);
  });

  it('never restricts the account tools', async () => {
    const { context, api } = policy({ defaultAction: 'deny' });
    const { spec, calls } = tool('auth_write', 'write', 'account');
    await run(spec, {}, context);
    expect(calls).toHaveLength(1);
    expect(api.calls).toHaveLength(0);
  });

  it('runs the tool without further checks when the workflow restricts nothing', async () => {
    const { context } = policy({ issueCreationBehavior: 'allow' });
    const { spec, calls } = tool('brain_write', 'write');
    expect(await run(spec, {}, context)).toEqual({ kind: 'json', data: { done: true } });
    expect(calls).toHaveLength(1);
  });

  it.each([
    [
      'a rule',
      { rules: [rule({ toolset: 'spec', effect: 'allow' })], issueCreationBehavior: 'allow' },
    ],
    ['a default deny', { defaultAction: 'deny', issueCreationBehavior: 'allow' }],
    ['supervised autonomy', { autonomy: 'supervised', issueCreationBehavior: 'allow' }],
  ])('still runs a read tool under %s', async (_, workflow) => {
    const { context } = policy(workflow);
    const { spec, calls } = tool('brain_list', 'read');
    await run(spec, {}, context);
    expect(calls).toHaveLength(1);
  });
});

describe('workflow policy: blocking rules', () => {
  it('blocks a tool matched by a deny rule of its module', async () => {
    const { context } = policy({ rules: [rule({ toolset: 'brain', effect: 'deny' })] });
    const { spec, calls } = tool('brain_list', 'read');
    const error = await rejection(run(spec, {}, context));
    expect(error?.code).toBe('WORKFLOW_ACTION_BLOCKED');
    expect(error?.message).toBe('Workflow blocked brain_list in the brain module.');
    expect(calls).toHaveLength(0);
  });

  it('blocks every module with a deny rule for all, and only the named tool of a tool rule', async () => {
    const all = policy({ rules: [rule({ toolset: 'all', effect: 'deny' })] });
    const blocked = await rejection(run(tool('spec_list', 'read', 'spec').spec, {}, all.context));
    expect(blocked?.code).toBe('WORKFLOW_ACTION_BLOCKED');

    const named = policy({
      rules: [rule({ toolset: 'brain', toolName: 'brain_delete', effect: 'deny' })],
    });
    const other = tool('brain_list', 'read');
    await run(other.spec, {}, named.context);
    expect(other.calls).toHaveLength(1);
    const target = await rejection(run(tool('brain_delete', 'read').spec, {}, named.context));
    expect(target?.code).toBe('WORKFLOW_ACTION_BLOCKED');
  });

  it('ignores rules of other modules', async () => {
    const { context } = policy({ rules: [rule({ toolset: 'spec', effect: 'deny' })] });
    const { spec, calls } = tool('brain_list', 'read');
    await run(spec, {}, context);
    expect(calls).toHaveLength(1);
  });

  it('denies unlisted write actions by default, and lets reads and allowed writes through', async () => {
    const denied = policy({ defaultAction: 'deny' });
    const error = await rejection(run(tool('brain_write', 'write').spec, {}, denied.context));
    expect(error?.code).toBe('WORKFLOW_ACTION_BLOCKED');
    expect(error?.message).toContain('denies unlisted write action brain_write');

    const read = tool('brain_list', 'read');
    await run(read.spec, {}, denied.context);
    expect(read.calls).toHaveLength(1);

    const allowed = policy({
      defaultAction: 'deny',
      rules: [rule({ toolset: 'brain', effect: 'allow' })],
    });
    const write = tool('brain_write', 'destructive');
    await run(write.spec, {}, allowed.context);
    expect(write.calls).toHaveLength(1);
  });
});

describe('workflow policy: allowed providers', () => {
  const allow = (...providers: string[][]) =>
    providers.map((allowedProviders, index) =>
      rule({ id: `p${index}`, toolset: 'brain', effect: 'allow', allowedProviders }),
    );

  it('lets through input whose provider id is allowed', async () => {
    const { context } = policy({ rules: allow(['github', 'azure_devops']) });
    const { spec, calls } = tool('brain_write', 'write');
    await run(spec, { provider: 'github', note: 'x' }, context);
    expect(calls).toHaveLength(1);
  });

  it('reads provider ids in arrays and objects, and ignores non-string values', async () => {
    const { context } = policy({ rules: allow(['github']) });
    const nestedTool = defineTool({
      name: 'brain_nested',
      title: 'Nested',
      description: 'A tool',
      toolset: 'brain',
      access: 'write',
      routes: [],
      input: { items: z.array(z.unknown()) },
      run: async () => json({ ok: true }),
    });
    const ok = [{ providerId: 'github' }, [{ Provider: 'github' }], { provider: 3 }, 'plain', null];
    await run(nestedTool, { items: ok }, context);

    const error = await rejection(
      run(
        nestedTool,
        { items: [{ provider: 'github' }, { nested: { providerId: 'gitlab' } }] },
        context,
      ),
    );
    expect(error?.code).toBe('WORKFLOW_PROVIDER_BLOCKED');
    expect(error?.message).toBe(
      'Workflow allows brain_nested only with these provider IDs: github.',
    );
  });

  it('blocks input that names no provider at all', async () => {
    const { context } = policy({ rules: allow(['github']) });
    const error = await rejection(run(tool('brain_write', 'write').spec, {}, context));
    expect(error?.code).toBe('WORKFLOW_PROVIDER_BLOCKED');
  });

  it('allows only the providers every matching rule allows', async () => {
    const { context } = policy({ rules: allow(['github', 'gitlab'], ['gitlab', 'azure_devops']) });
    const { spec, calls } = tool('brain_write', 'write');
    await run(spec, { provider: 'gitlab' }, context);
    expect(calls).toHaveLength(1);
    const error = await rejection(run(spec, { provider: 'github' }, context));
    expect(error?.message).toContain('only with these provider IDs: gitlab.');
  });

  it('reports "(none)" when no provider is allowed', async () => {
    const { context } = policy({ rules: allow(['github'], ['gitlab']) });
    const error = await rejection(
      run(tool('brain_write', 'write').spec, { provider: 'github' }, context),
    );
    expect(error?.message).toContain('provider IDs: (none).');
  });
});

describe('workflow policy: human approval', () => {
  const supervised = { autonomy: 'supervised', issueCreationBehavior: 'allow' };

  it('asks for approval before a supervised write, with the secrets of the input redacted', async () => {
    const { context } = policy(supervised);
    const prompts: string[] = [];
    const { spec, calls } = tool('brain_write', 'write');
    const input = { note: 'visible' };
    await run(spec, input, {
      ...context,
      requestApproval: async (prompt) => {
        prompts.push(prompt);
        return true;
      },
    });
    expect(calls).toHaveLength(1);
    expect(prompts[0]).toContain('Approve this write action: Title of brain_write (brain_write)?');
    expect(prompts[0]).toContain('"note": "visible"');
  });

  it('redacts secret-looking fields at any depth in the approval prompt', async () => {
    const { context } = policy(supervised);
    const prompts: string[] = [];
    const nestedTool = defineTool({
      name: 'brain_secret',
      title: 'Secret',
      description: 'A tool',
      toolset: 'brain',
      access: 'write',
      routes: [],
      input: { config: z.unknown() },
      run: async () => json({}),
    });
    await run(
      nestedTool,
      {
        config: {
          password: 'hunter2',
          apiKey: 'k',
          list: [{ Authorization: 'Bearer x', keep: 1 }, 'text'],
          count: 2,
        },
      },
      {
        ...context,
        requestApproval: async (prompt) => {
          prompts.push(prompt);
          return true;
        },
      },
    );
    expect(prompts[0]).not.toContain('hunter2');
    expect(prompts[0]).not.toContain('Bearer x');
    expect(prompts[0]).toContain('"password": "[redacted]"');
    expect(prompts[0]).toContain('"apiKey": "[redacted]"');
    expect(prompts[0]).toContain('"keep": 1');
    expect(prompts[0]).toContain('"count": 2');
  });

  it('does not ask for approval of a read', async () => {
    const { context } = policy(supervised);
    const { spec, calls } = tool('brain_list', 'read');
    await run(spec, {}, { ...context, requestApproval: async () => false });
    expect(calls).toHaveLength(1);
  });

  it('asks before creating an issue when the workflow says to ask, but not for other writes', async () => {
    const { context } = policy({ issueCreationBehavior: 'ask' });
    const asked: string[] = [];
    const approve = {
      ...context,
      requestApproval: async (prompt: string) => {
        asked.push(prompt);
        return true;
      },
    };
    await run(tool('issues_create', 'write', 'issues').spec, {}, approve);
    expect(asked).toHaveLength(1);
    const other = tool('brain_write', 'write');
    await run(other.spec, {}, approve);
    expect(asked).toHaveLength(1);
    expect(other.calls).toHaveLength(1);
  });

  it('asks when a matching allow rule requires approval', async () => {
    const { context } = policy({
      issueCreationBehavior: 'allow',
      rules: [rule({ toolset: 'brain', effect: 'allow', requireApproval: true })],
    });
    const error = await rejection(run(tool('brain_write', 'write').spec, {}, context));
    expect(error?.code).toBe('WORKFLOW_APPROVAL_UNAVAILABLE');
  });

  it('does nothing when the client cannot be asked', async () => {
    const { context } = policy(supervised);
    const { spec, calls } = tool('brain_write', 'write');
    const error = await rejection(run(spec, {}, context));
    expect(error?.code).toBe('WORKFLOW_APPROVAL_UNAVAILABLE');
    expect(error?.message).toContain('does not support approval requests');
    expect(calls).toHaveLength(0);
  });

  it('does nothing when asking fails', async () => {
    const { context } = policy(supervised);
    const { spec, calls } = tool('brain_write', 'write');
    const error = await rejection(
      run(
        spec,
        {},
        {
          ...context,
          requestApproval: async () => {
            throw new Error('elicitation unsupported');
          },
        },
      ),
    );
    expect(error?.code).toBe('WORKFLOW_APPROVAL_UNAVAILABLE');
    expect(error?.message).toContain('Could not request human approval');
    expect(calls).toHaveLength(0);
  });

  it('does nothing when the user declines', async () => {
    const { context } = policy(supervised);
    const { spec, calls } = tool('brain_write', 'write');
    const error = await rejection(
      run(spec, {}, { ...context, requestApproval: async () => false }),
    );
    expect(error?.code).toBe('WORKFLOW_APPROVAL_DECLINED');
    expect(calls).toHaveLength(0);
  });
});

describe('workflow policy: tracking issues', () => {
  const tracked = (extra: Record<string, unknown> = {}) =>
    policy({
      issueCreationBehavior: 'allow',
      rules: [
        rule({ name: 'Track it', toolset: 'brain', effect: 'allow', createIssueForAction: true }),
      ],
      ...extra,
    });

  const patchAndComment = (calls: readonly ApiRequest[]) => ({
    patch: calls.find((call) => call.method === 'PATCH'),
    comment: calls.find((call) => call.path.endsWith('/comments')),
  });

  function withIssue(setup: ReturnType<typeof tracked>) {
    setup.api.on('POST /issues', () => ({ issue: { id: 'i/1' } }));
    return setup;
  }

  it('opens an issue for a write, tags a json object result and closes the issue as done', async () => {
    const { context, api } = withIssue(tracked());
    const { spec } = tool('brain_write', 'write');
    const result = await run(spec, { note: 'x', token: 'secret' }, context);
    expect(result).toEqual({ kind: 'json', data: { done: true, workflowTrackingIssueId: 'i/1' } });
    const created = api.calls.find((call) => call.method === 'POST' && call.path === '/issues')!;
    const body = created.body as { title: string; description: string; status: string };
    expect(body.title).toBe('MCP action: Title of brain_write');
    expect(body.status).toBe('in_progress');
    expect(body.description).toContain('Opened automatically by workflow rule “Track it”.');
    expect(body.description).toContain('"token": "[redacted]"');
    expect(body.description).not.toContain('secret');
    const { patch, comment } = patchAndComment(api.calls);
    expect(patch).toMatchObject({ path: '/issues/i%2F1', body: { status: 'done' } });
    expect(comment!.body).toEqual({ body: "MCP action 'brain_write' completed." });
  });

  it('appends the issue to a text result', async () => {
    const { context } = withIssue(tracked());
    const { spec } = tool('brain_write', 'write', 'brain', text('Saved.'));
    expect(await run(spec, {}, context)).toEqual({
      kind: 'text',
      text: 'Saved.\n\nWorkflow tracking Issue: i/1',
    });
  });

  it.each([
    ['an array', [1, 2]],
    ['a string', 'plain'],
    ['nothing', null],
  ])('wraps %s result next to the issue id', async (_, data) => {
    const { context } = withIssue(tracked());
    const { spec } = tool('brain_write', 'write', 'brain', json(data));
    expect(await run(spec, {}, context)).toEqual({
      kind: 'json',
      data: { result: data, workflowTrackingIssueId: 'i/1' },
    });
  });

  it('blocks the issue and rethrows when the tool fails', async () => {
    const { context, api } = withIssue(tracked());
    const failing = defineTool({
      name: 'brain_fail',
      title: 'Fail',
      description: 'A tool',
      toolset: 'brain',
      access: 'write',
      routes: [],
      input: {},
      run: async () => {
        throw new Error('backend down');
      },
    });
    await expect(run(failing, {}, context)).rejects.toThrow('backend down');
    const { patch, comment } = patchAndComment(api.calls);
    expect(patch!.body).toEqual({ status: 'blocked' });
    expect(comment!.body).toEqual({ body: "MCP action 'brain_fail' failed before completion." });
  });

  it('still returns the result when closing the issue fails', async () => {
    const { context, api } = withIssue(tracked());
    api.on('PATCH /issues/i%2F1', () => {
      throw new Error('boom');
    });
    const { spec } = tool('brain_write', 'write');
    expect(await run(spec, {}, context)).toMatchObject({ kind: 'json' });
  });

  it('opens no issue for reads, for the issue tools themselves, or without the rule option', async () => {
    const setup = tracked();
    const read = tool('brain_list', 'read');
    await run(read.spec, {}, setup.context);
    const create = tool('issues_create', 'write', 'brain');
    await run(create.spec, {}, setup.context);
    expect(setup.api.calls.filter((call) => call.path.startsWith('/issues'))).toHaveLength(0);

    const plain = policy({
      issueCreationBehavior: 'allow',
      rules: [rule({ toolset: 'brain', effect: 'allow' })],
    });
    const write = tool('brain_write', 'write');
    expect(await run(write.spec, {}, plain.context)).toEqual({
      kind: 'json',
      data: { done: true },
    });
    expect(plain.api.calls.filter((call) => call.path.startsWith('/issues'))).toHaveLength(0);
  });

  it('truncates a very large action input in the issue description', async () => {
    const { context, api } = withIssue(tracked());
    const { spec } = tool('brain_write', 'write');
    await run(spec, { note: 'x'.repeat(30_000) }, context);
    const created = api.calls.find((call) => call.path === '/issues')!;
    expect((created.body as { description: string }).description.length).toBeLessThan(20_300);
  });
});
