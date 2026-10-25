import { describe, expect, it, vi } from 'vitest';
import { InMemoryIssueStore } from '../src/modules/issues/issue-store.js';
import { InMemoryRunStore } from '../src/modules/issues/run-store.js';
import { RunService } from '../src/modules/issues/run-service.js';
import { fakeRunAgents } from './helpers/fake-run-agents.js';

const workspaceId = 'workspace-a';
const context = { requestId: 'test', workspaceId, ownerId: 'owner-a', actorId: 'user-a' };
const agentId = 'agent-a';

function setup(
  executeAgent = vi.fn().mockResolvedValue({
    result: 'Completed work',
    provider: 'OpenAI',
    model: 'model-a',
    usage: { inputTokens: 1000, outputTokens: 500 },
  }),
) {
  const issues = new InMemoryIssueStore();
  const store = new InMemoryRunStore();
  const agents = fakeRunAgents(executeAgent, {
    agent: { id: agentId, name: 'Agent' },
    workflow: { finalReview: false },
  });
  const runs = new RunService(store, issues, agents);
  const createIssue = (title: string) =>
    issues.create(workspaceId, 'user-a', { title, assigneeAgentId: agentId });
  return { issues, store, runs, createIssue, executeAgent };
}

describe('agent issue runs', () => {
  it('executes an assigned issue and records provider tokens and configured spend', async () => {
    const { issues, runs, createIssue, executeAgent } = setup();
    const issue = await createIssue('Review payments');
    await runs.setRate({
      workspaceId,
      provider: 'OpenAI',
      model: 'model-a',
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 8,
    });
    const queued = await runs.create(issue.id, context);
    await vi.waitFor(async () =>
      expect((await runs.get(workspaceId, queued.id)).status).toBe('succeeded'),
    );
    const result = await runs.get(workspaceId, queued.id);
    expect(executeAgent).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      output: '## Agent\n\nCompleted work',
      inputTokens: 1000,
      outputTokens: 500,
      costMicros: 6000,
    });
    expect((await issues.get(workspaceId, issue.id))?.status).toBe('done');
    expect((await runs.costs(workspaceId)).monthSpendMicros).toBe(6000);
    expect(await runs.costs(workspaceId)).toMatchObject({
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      totalTokens: 1500,
    });
  });

  it('audits tokens across all time, including runs without a price', async () => {
    const { runs, createIssue } = setup();
    const issue = await createIssue('Historical run');
    const run = await runs.create(issue.id, context, 'host');
    await runs.checkout(workspaceId, run.id);
    const completed = await runs.completeHost(workspaceId, run.id, {
      output: 'Done',
      inputTokens: 12,
      outputTokens: 8,
    });
    completed.createdAt = new Date('2020-01-01T00:00:00.000Z');
    expect(await runs.costs(workspaceId)).toMatchObject({
      monthSpendMicros: 0,
      totalInputTokens: 12,
      totalOutputTokens: 8,
      totalTokens: 20,
    });
  });

  it('prevents duplicate claims and enforces the monthly spend cutoff', async () => {
    let resolve!: (result: unknown) => void;
    const pending = new Promise((done) => {
      resolve = done;
    });
    const { runs, createIssue } = setup(vi.fn().mockReturnValue(pending));
    const issue = await createIssue('First');
    await runs.setRate({
      workspaceId,
      provider: 'OpenAI',
      model: 'model-a',
      inputUsdPerMillion: 1000,
      outputUsdPerMillion: 0,
    });
    await runs.setBudget(workspaceId, 1_000_000);
    const first = await runs.create(issue.id, context);
    await expect(runs.create(issue.id, context)).rejects.toMatchObject({
      code: 'ISSUE_ALREADY_RUNNING',
    });
    resolve({
      result: 'Done',
      provider: 'OpenAI',
      model: 'model-a',
      usage: { inputTokens: 1000, outputTokens: 0 },
    });
    await vi.waitFor(async () =>
      expect((await runs.get(workspaceId, first.id)).status).toBe('succeeded'),
    );
    const secondIssue = await createIssue('Second');
    await expect(runs.create(secondIssue.id, context)).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
    });
  });

  it('supports host checkout, completion and cancellation', async () => {
    const { runs, createIssue, issues } = setup();
    const issue = await createIssue('External task');
    const host = await runs.create(issue.id, context, 'host');
    expect((await runs.checkout(workspaceId, host.id)).status).toBe('running');
    expect(
      (await runs.completeHost(workspaceId, host.id, { output: 'Reviewed in MCP' })).status,
    ).toBe('succeeded');
    expect((await issues.get(workspaceId, issue.id))?.status).toBe('done');
    await expect(runs.checkout(workspaceId, host.id)).rejects.toMatchObject({
      code: 'INVALID_RUN_STATE',
    });
    await expect(runs.create(issue.id, context, 'host')).rejects.toMatchObject({
      code: 'ISSUE_CLOSED',
    });
    await issues.update(workspaceId, issue.id, { status: 'todo' });
    const next = await runs.create(issue.id, context, 'host');
    expect((await runs.cancel(workspaceId, next.id)).status).toBe('cancelled');
    expect((await issues.get(workspaceId, issue.id))?.status).toBe('todo');
  });

  it('does not publish a late model result after cancellation', async () => {
    let resolve!: (result: unknown) => void;
    const pending = new Promise((done) => {
      resolve = done;
    });
    const { runs, issues, createIssue } = setup(vi.fn().mockReturnValue(pending));
    const issue = await createIssue('Cancelled work');
    const run = await runs.create(issue.id, context);
    await vi.waitFor(async () =>
      expect((await runs.get(workspaceId, run.id)).status).toBe('running'),
    );
    await runs.cancel(workspaceId, run.id);
    resolve({
      result: 'Late work',
      provider: 'OpenAI',
      model: 'model-a',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await Promise.resolve();
    expect((await runs.get(workspaceId, run.id)).status).toBe('cancelled');
    expect((await issues.get(workspaceId, issue.id))?.status).toBe('todo');
  });

  it('includes comments in the prompt, replies as the agent, and handles comments added during a run', async () => {
    let resolveFirst!: (result: unknown) => void;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const executeAgent = vi.fn().mockReturnValueOnce(first).mockResolvedValue({
      result: 'I updated the checklist and need approval.',
      provider: 'OpenAI',
    });
    const { runs, issues, createIssue } = setup(executeAgent);
    const issue = await createIssue('Review release');
    const initial = await runs.create(issue.id, context);
    await vi.waitFor(() => expect(executeAgent).toHaveBeenCalledTimes(1));
    const comment = await issues.addComment(issue.id, 'user-a', 'Please add a rollback step.');
    resolveFirst({ result: 'Initial result', provider: 'OpenAI' });
    await vi.waitFor(() => expect(executeAgent).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () =>
      expect((await runs.list(workspaceId, issue.id))[0]?.status).toBe('succeeded'),
    );
    const prompt = executeAgent.mock.calls[1]?.[2]?.prompt as string;
    expect(prompt).toContain(`[${comment.id}] User: Please add a rollback step.`);
    expect(prompt).toContain('Carry out the requested work when possible.');
    expect((await issues.comments(issue.id)).at(-1)).toMatchObject({
      authorId: agentId,
      body: '## Agent\n\nI updated the checklist and need approval.',
    });
    expect((await runs.get(workspaceId, initial.id)).status).toBe('succeeded');
  });

  it('replies to a comment after a completed host run', async () => {
    const { runs, issues, createIssue } = setup();
    const issue = await createIssue('Check migration');
    const initial = await runs.create(issue.id, context, 'host');
    await runs.checkout(workspaceId, initial.id);
    await runs.completeHost(workspaceId, initial.id, { output: 'Draft ready' });
    await issues.update(workspaceId, issue.id, { status: 'done' });
    const comment = await issues.addComment(issue.id, 'user-a', 'Could you clarify the rollback?');
    const reply = await runs.create(issue.id, context, 'host', comment);
    expect(reply.prompt).toContain(comment.body);
    expect((await issues.get(workspaceId, issue.id))?.status).toBe('in_progress');
    await runs.checkout(workspaceId, reply.id);
    await runs.completeHost(workspaceId, reply.id, {
      output: 'The rollback restores the old mapping.',
    });
    expect((await issues.comments(issue.id)).at(-1)).toMatchObject({
      authorId: agentId,
      body: 'The rollback restores the old mapping.',
    });
  });
});
