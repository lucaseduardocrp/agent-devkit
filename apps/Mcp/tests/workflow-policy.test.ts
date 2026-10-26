import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, json, text, type ToolAccess, type ToolResult } from '../src/core/tool.js';
import { executeWithWorkflowPolicy } from '../src/core/workflow-policy.js';
import { fakeContext, fixtures } from './support/fake-api.js';

interface ToolOptions {
  readonly name?: string;
  readonly toolset?: 'pbi' | 'account';
  readonly access?: ToolAccess;
  readonly result?: ToolResult;
  readonly fail?: boolean;
}

function tool(options: ToolOptions = {}) {
  return defineTool({
    name: options.name ?? 'pbi_push',
    title: 'Push PBI',
    description: 'Test tool.',
    toolset: options.toolset ?? 'pbi',
    access: options.access ?? 'write',
    routes: [],
    input: { provider: z.string().optional(), nested: z.unknown().optional() },
    run: () =>
      options.fail
        ? Promise.reject(new Error('boom'))
        : Promise.resolve(options.result ?? json({ ok: true })),
  });
}

function setup(
  workflow: Record<string, unknown>,
  approval?: (message: string) => Promise<boolean>,
) {
  const fake = fakeContext();
  fake.api.on('GET /agents/workflow', () => ({
    workflow: { ...fixtures.workflow, issueCreationBehavior: 'create', ...workflow },
  }));
  fake.api.on('POST /issues', () => ({ issue: { id: 'iss-1' } }));
  const context = approval ? { ...fake.context, requestApproval: approval } : fake.context;
  return { ...fake, context };
}

const paths = (calls: readonly { method: string; path: string }[]) =>
  calls.map((call) => `${call.method} ${call.path}`);

describe('workflow policy', () => {
  it('skips the policy without a workspace or for account tools', async () => {
    const empty = fakeContext({ token: 't' });
    await executeWithWorkflowPolicy(tool(), {}, empty.context);
    const account = setup({});
    await executeWithWorkflowPolicy(tool({ toolset: 'account' }), {}, account.context);
    expect([...empty.api.calls, ...account.api.calls]).toEqual([]);
  });

  it('runs directly under a permissive workflow', async () => {
    await expect(executeWithWorkflowPolicy(tool(), {}, setup({}).context)).resolves.toEqual(
      json({ ok: true }),
    );
  });

  it('blocks denied tools and unlisted writes when the default is deny', async () => {
    const denied = setup({
      rules: [{ id: 'r', name: 'R', toolset: 'all', toolName: 'pbi_push', effect: 'deny' }],
    });
    await expect(executeWithWorkflowPolicy(tool(), {}, denied.context)).rejects.toMatchObject({
      code: 'WORKFLOW_ACTION_BLOCKED',
    });
    const strict = setup({
      defaultAction: 'deny',
      rules: [
        { id: 'o', name: 'Other', toolset: 'issues', effect: 'allow' },
        { id: 'n', name: 'Named', toolset: 'pbi', toolName: 'pbi_other', effect: 'allow' },
      ],
    });
    await expect(executeWithWorkflowPolicy(tool(), {}, strict.context)).rejects.toThrow(
      /unlisted write action pbi_push/,
    );
    await expect(
      executeWithWorkflowPolicy(tool({ access: 'read' }), {}, strict.context),
    ).resolves.toEqual(json({ ok: true }));
  });

  it('allows only the provider ids every matching rule accepts', async () => {
    const { context } = setup({
      defaultAction: 'deny',
      rules: [
        {
          id: 'a',
          name: 'A',
          toolset: 'pbi',
          effect: 'allow',
          allowedProviders: ['github', 'jira'],
        },
        { id: 'b', name: 'B', toolset: 'all', effect: 'allow', allowedProviders: ['github'] },
      ],
    });
    await expect(
      executeWithWorkflowPolicy(
        tool(),
        { nested: [{ providerId: 'github', other: 1 }, 'x', null] },
        context,
      ),
    ).resolves.toEqual(json({ ok: true }));
    await expect(
      executeWithWorkflowPolicy(tool(), { provider: 'jira' }, context),
    ).rejects.toMatchObject({ code: 'WORKFLOW_PROVIDER_BLOCKED' });
    await expect(
      executeWithWorkflowPolicy(tool(), { nested: { provider: 7 } }, context),
    ).rejects.toThrow(/provider IDs: github\./);
    const none = setup({
      rules: [{ id: 'c', name: 'C', toolset: 'pbi', effect: 'allow', allowedProviders: [] }],
    });
    await expect(
      executeWithWorkflowPolicy(tool(), { provider: 'github' }, none.context),
    ).rejects.toThrow(/\(none\)/);
  });

  it('asks for approval with secrets redacted and honours the answer', async () => {
    const prompts: string[] = [];
    const approved = setup({ autonomy: 'supervised' }, (prompt) => {
      prompts.push(prompt);
      return Promise.resolve(true);
    });
    await executeWithWorkflowPolicy(
      tool(),
      { nested: [{ apiKey: 'sk-1', note: 'hi' }] },
      approved.context,
    );
    expect(prompts[0]).toContain('[redacted]');
    expect(prompts[0]).not.toContain('sk-1');

    const declined = setup({ issueCreationBehavior: 'ask' }, () => Promise.resolve(false));
    await expect(
      executeWithWorkflowPolicy(tool({ name: 'issues_create' }), {}, declined.context),
    ).rejects.toMatchObject({ code: 'WORKFLOW_APPROVAL_DECLINED' });

    const rule = {
      rules: [{ id: 'r', name: 'R', toolset: 'pbi', effect: 'allow', requireApproval: true }],
    };
    const broken = setup(rule, () => Promise.reject(new Error('no ui')));
    await expect(executeWithWorkflowPolicy(tool(), {}, broken.context)).rejects.toThrow(
      /Could not request human approval/,
    );
    const unsupported = setup(rule);
    await expect(executeWithWorkflowPolicy(tool(), {}, unsupported.context)).rejects.toMatchObject({
      code: 'WORKFLOW_APPROVAL_UNAVAILABLE',
    });
    await expect(
      executeWithWorkflowPolicy(tool({ access: 'read' }), {}, unsupported.context),
    ).resolves.toEqual(json({ ok: true }));
  });

  it('tracks write actions in an Issue and reports its id with the result', async () => {
    const rules = [
      { id: 'r', name: 'Track', toolset: 'pbi', effect: 'allow', createIssueForAction: true },
    ];
    const run = async (options: ToolOptions, input: unknown = {}) => {
      const fake = setup({ rules });
      const result = await executeWithWorkflowPolicy(tool(options), input, fake.context);
      return { result, calls: fake.api.calls };
    };

    const tracked = await run({}, { password: 'hunter2' });
    expect(tracked.result).toEqual(json({ ok: true, workflowTrackingIssueId: 'iss-1' }));
    expect(paths(tracked.calls)).toEqual([
      'GET /agents/workflow',
      'POST /issues',
      'PATCH /issues/iss-1',
      'POST /issues/iss-1/comments',
    ]);
    expect(JSON.stringify(tracked.calls[1]!.body)).not.toContain('hunter2');
    expect(tracked.calls[2]!.body).toEqual({ status: 'done' });

    expect((await run({ result: text('Done') })).result).toEqual(
      text('Done\n\nWorkflow tracking Issue: iss-1'),
    );
    expect((await run({ result: json([1]) })).result).toEqual(
      json({ result: [1], workflowTrackingIssueId: 'iss-1' }),
    );
    expect((await run({ result: json(null) })).result).toEqual(
      json({ result: null, workflowTrackingIssueId: 'iss-1' }),
    );
    expect(paths((await run({ access: 'read' })).calls)).toEqual(['GET /agents/workflow']);
    expect(paths((await run({ name: 'pbi_create_issue' })).calls)).toEqual([
      'GET /agents/workflow',
    ]);

    const failing = setup({ rules });
    await expect(
      executeWithWorkflowPolicy(tool({ fail: true }), {}, failing.context),
    ).rejects.toThrow('boom');
    expect(failing.api.calls[2]!.body).toEqual({ status: 'blocked' });
    const untracked = setup({ rules: [{ id: 'x', name: 'X', toolset: 'pbi', effect: 'allow' }] });
    await expect(
      executeWithWorkflowPolicy(tool({ fail: true }), {}, untracked.context),
    ).rejects.toThrow('boom');
    expect(paths(untracked.api.calls)).toEqual(['GET /agents/workflow']);
  });
});
