import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryIssueStore } from '../src/modules/issues/issue-store.js';
import { InMemoryRunStore, type AgentRun, type RunStore } from '../src/modules/issues/run-store.js';
import { RunService } from '../src/modules/issues/run-service.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';
import type { PbiStore } from '../src/modules/pbi/pbi-store.js';
import { ApplicationError } from '../src/shared/errors.js';

const workspaceId = 'workspace-a';
const context = { requestId: 'test', workspaceId, ownerId: 'owner-a', actorId: 'user-a' };
const agentId = 'agent-a';

/** A run store that also owns issue status transitions, like the Prisma store. */
function managed(store: InMemoryRunStore): RunStore {
  const view = Object.create(store) as RunStore;
  Object.defineProperty(view, 'managesIssueStatus', { value: true });
  return view;
}

function setup(options: { executeAgent?: ReturnType<typeof vi.fn>; managed?: boolean } = {}) {
  const issues = new InMemoryIssueStore();
  const memory = new InMemoryRunStore();
  const store = options.managed ? managed(memory) : memory;
  const executeAgent =
    options.executeAgent ??
    vi.fn().mockResolvedValue({ result: 'Done', provider: 'OpenAI', model: 'm' });
  const agents = {
    getAgent: vi.fn().mockResolvedValue({ id: agentId }),
    executeAgent,
  } as unknown as AgentService & { getAgent: ReturnType<typeof vi.fn> };
  const runs = new RunService(store, issues, agents);
  const createIssue = (title = 'Task') =>
    issues.create(workspaceId, 'user-a', { title, assigneeAgentId: agentId });
  return { issues, store: memory, runs, agents, executeAgent, createIssue };
}

afterEach(() => vi.restoreAllMocks());

describe('RunService recovery', () => {
  it('requeues queued server runs, fails interrupted ones and ignores host runs', async () => {
    const { runs, store, issues, executeAgent, createIssue } = setup();
    const queuedIssue = await createIssue('Queued');
    const runningIssue = await createIssue('Running');
    const hostIssue = await createIssue('Host');
    const base = { workspaceId, agentId, actorId: 'u', ownerId: 'o', prompt: 'p', attempt: 1 };
    const queued = (await store.claim({ ...base, issueId: queuedIssue.id, mode: 'server' }))!;
    const running = (await store.claim({ ...base, issueId: runningIssue.id, mode: 'server' }))!;
    await store.start(workspaceId, running.id);
    const host = (await store.claim({ ...base, issueId: hostIssue.id, mode: 'host' }))!;
    await runs.recover();
    expect(await store.get(workspaceId, running.id)).toMatchObject({
      status: 'failed',
      error: 'Backend restarted during execution. Retry the issue.',
    });
    expect((await issues.get(workspaceId, runningIssue.id))?.status).toBe('blocked');
    await vi.waitFor(async () =>
      expect((await store.get(workspaceId, queued.id))?.status).toBe('succeeded'),
    );
    expect(executeAgent).toHaveBeenCalledOnce();
    expect((await store.get(workspaceId, host.id))?.status).toBe('queued');
  });

  it('logs recovered runs that fail to execute and leaves issue status to managing stores', async () => {
    const { runs, store, issues, createIssue } = setup({ managed: true });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const issue = await createIssue();
    const other = await createIssue('Other');
    const base = { workspaceId, agentId, actorId: 'u', ownerId: 'o', prompt: 'p', attempt: 1 };
    await store.claim({ ...base, issueId: issue.id, mode: 'server' });
    const running = (await store.claim({ ...base, issueId: other.id, mode: 'server' }))!;
    await store.start(workspaceId, running.id);
    vi.spyOn(store, 'start').mockRejectedValue(new Error('database down'));
    await runs.recover();
    expect((await issues.get(workspaceId, other.id))?.status).toBe('todo');
    await vi.waitFor(() =>
      expect(errors).toHaveBeenCalledWith('[RunService] Run failed:', expect.any(Error)),
    );
  });
});

describe('RunService validation', () => {
  it('normalizes rates on removal and rejects runs without workspace, issue or agent', async () => {
    const { runs, issues } = setup();
    await runs.setRate({
      workspaceId,
      provider: 'OpenAI',
      model: 'm',
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
    });
    expect(await runs.removeRate(workspaceId, ' OPENAI ', ' m ')).toBe(true);
    await expect(runs.create('x', { requestId: 'r' })).rejects.toMatchObject({
      code: 'WORKSPACE_REQUIRED',
    });
    await expect(runs.create('missing', context)).rejects.toMatchObject({
      code: 'ISSUE_NOT_FOUND',
    });
    const unassigned = await issues.create(workspaceId, 'user-a', { title: 'No agent' });
    await expect(runs.create(unassigned.id, context)).rejects.toMatchObject({
      code: 'AGENT_REQUIRED',
    });
    const closed = await issues.create(workspaceId, 'user-a', {
      title: 'Closed',
      assigneeAgentId: agentId,
      status: 'done',
    });
    await expect(runs.create(closed.id, context)).rejects.toMatchObject({ code: 'ISSUE_CLOSED' });
    await expect(runs.get(workspaceId, 'missing')).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    });
  });

  it('builds the prompt from the linked PBI tree and falls back to issue defaults', async () => {
    const issues = new InMemoryIssueStore();
    const store = new InMemoryRunStore();
    const agents = { getAgent: vi.fn() } as unknown as AgentService;
    const pbiItems = {
      get: vi.fn(async (_ws: string, id: string) =>
        id === 'root' ? { id: 'root', title: 'Epic', description: 'Root' } : null,
      ),
      list: vi.fn().mockResolvedValue([
        { id: 'child', parentId: 'root', title: 'Story', description: 'Child' },
        { id: 'leaf', parentId: 'child', title: 'Task', description: 'Leaf' },
        { id: 'stray', parentId: 'other', title: 'Stray', description: 'No' },
      ]),
    } as unknown as PbiStore;
    const runs = new RunService(store, issues, agents, pbiItems);
    const linked = await issues.create(workspaceId, 'creator', {
      title: 'Linked',
      assigneeAgentId: agentId,
      pbiItemId: 'root',
    });
    const run = await runs.create(linked.id, { requestId: 'r', workspaceId }, 'host');
    expect(run.prompt).toContain(
      'Current PBI context:\nEpic: Root\n- Story: Child\n  - Task: Leaf',
    );
    expect(run.prompt).not.toContain('Stray');
    expect(run).toMatchObject({ actorId: 'creator', ownerId: workspaceId });
    const missing = await issues.create(workspaceId, 'creator', {
      title: 'Missing PBI',
      assigneeAgentId: agentId,
      pbiItemId: 'gone',
    });
    expect((await runs.create(missing.id, context, 'host')).prompt).not.toContain('PBI context');
  });
});

describe('RunService server execution', () => {
  it('marks failed executions, truncates errors and blocks the issue', async () => {
    const executeAgent = vi.fn().mockRejectedValue(new Error('x'.repeat(5000)));
    const { runs, issues, createIssue } = setup({ executeAgent });
    const issue = await createIssue();
    const run = await runs.create(issue.id, context);
    await vi.waitFor(async () =>
      expect((await runs.get(workspaceId, run.id)).status).toBe('failed'),
    );
    expect((await runs.get(workspaceId, run.id)).error).toHaveLength(4000);
    expect((await issues.get(workspaceId, issue.id))?.status).toBe('blocked');
  });

  it('uses a generic message for non-error failures and skips issue updates for managing stores', async () => {
    const executeAgent = vi.fn().mockRejectedValue('boom');
    const { runs, issues, createIssue } = setup({ executeAgent, managed: true });
    const issue = await createIssue();
    const run = await runs.create(issue.id, context);
    await vi.waitFor(async () =>
      expect((await runs.get(workspaceId, run.id)).error).toBe('Agent execution failed.'),
    );
    expect((await issues.get(workspaceId, issue.id))?.status).toBe('todo');
  });

  it('records successful runs without usage and leaves status to managing stores', async () => {
    const executeAgent = vi.fn().mockResolvedValue({ result: 'Ok', provider: 'OpenAI' });
    const { runs, issues, createIssue } = setup({ executeAgent, managed: true });
    const issue = await createIssue();
    const run = await runs.create(issue.id, context);
    await vi.waitFor(async () =>
      expect(await runs.get(workspaceId, run.id)).toMatchObject({
        status: 'succeeded',
        model: null,
        inputTokens: null,
        outputTokens: null,
        costMicros: null,
      }),
    );
    expect((await issues.get(workspaceId, issue.id))?.status).toBe('todo');
  });

  it('does not touch the issue when the run was finished elsewhere', async () => {
    let fail!: (error: unknown) => void;
    let succeed!: (value: unknown) => void;
    const executeAgent = vi
      .fn()
      .mockReturnValueOnce(new Promise((_resolve, reject) => (fail = reject)))
      .mockReturnValueOnce(new Promise((resolve) => (succeed = resolve)));
    const { runs, store, issues, createIssue } = setup({ executeAgent });
    const first = await createIssue('First');
    const second = await createIssue('Second');
    const failing = await runs.create(first.id, context);
    const passing = await runs.create(second.id, context);
    await vi.waitFor(() => expect(executeAgent).toHaveBeenCalledTimes(2));
    await store.finish(workspaceId, failing.id, 'succeeded', {});
    await store.finish(workspaceId, passing.id, 'failed', {});
    await issues.update(workspaceId, first.id, { status: 'todo' });
    await issues.update(workspaceId, second.id, { status: 'todo' });
    fail(new Error('late'));
    succeed({ result: 'late', provider: 'OpenAI' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await issues.get(workspaceId, first.id))?.status).toBe('todo');
    expect((await issues.get(workspaceId, second.id))?.status).toBe('todo');
  });

  it('skips execution when the run can no longer start and logs unexpected failures', async () => {
    const { runs, store, executeAgent, createIssue } = setup();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const start = vi.spyOn(store, 'start').mockResolvedValueOnce(null);
    const issue = await createIssue();
    const skipped = await runs.create(issue.id, context);
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(executeAgent).not.toHaveBeenCalled();
    await store.finish(workspaceId, skipped.id, 'cancelled', {});
    start.mockRejectedValueOnce(new Error('start failed'));
    await runs.create(issue.id, context);
    await vi.waitFor(() =>
      expect(errors).toHaveBeenCalledWith('[RunService] Run failed:', expect.any(Error)),
    );
  });

  it('logs comment follow-ups that cannot start', async () => {
    let finish!: (value: unknown) => void;
    const executeAgent = vi
      .fn()
      .mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
      .mockResolvedValue({ result: 'Ok', provider: 'OpenAI' });
    const { runs, agents, issues, createIssue } = setup({ executeAgent });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const issue = await createIssue();
    await runs.create(issue.id, context);
    await vi.waitFor(() => expect(executeAgent).toHaveBeenCalledOnce());
    await issues.addComment(issue.id, 'user-a', 'One more thing');
    agents.getAgent.mockRejectedValueOnce(new Error('agent removed'));
    finish({ result: 'Ok', provider: 'OpenAI' });
    await vi.waitFor(() =>
      expect(errors).toHaveBeenCalledWith(
        '[RunService] Could not start comment follow-up:',
        expect.any(Error),
      ),
    );
  });

  it('logs rejected follow-ups but stays silent when another run already took the comment', async () => {
    const { runs, agents, store, issues, createIssue } = setup();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const issue = await createIssue();
    const first = await runs.create(issue.id, context, 'host');
    await runs.checkout(workspaceId, first.id);
    await issues.addComment(issue.id, 'user-a', 'Follow up');
    vi.spyOn(store, 'claim').mockResolvedValueOnce(null);
    await runs.completeHost(workspaceId, first.id, { output: 'Done' });
    expect(errors).not.toHaveBeenCalled();

    const second = await createIssue('Second');
    const run = await runs.create(second.id, context, 'host');
    await runs.checkout(workspaceId, run.id);
    await issues.addComment(second.id, 'user-a', 'Follow up');
    agents.getAgent.mockRejectedValueOnce(
      new ApplicationError('AGENT_NOT_FOUND', 'Agent not found.', 404),
    );
    await runs.completeHost(workspaceId, run.id, { output: 'Done' });
    expect(errors).toHaveBeenCalledWith(
      '[RunService] Could not start comment follow-up:',
      expect.objectContaining({ code: 'AGENT_NOT_FOUND' }),
    );
  });

  it('stops follow-ups when the issue lost its agent', async () => {
    const { runs, issues, createIssue, executeAgent } = setup();
    const issue = await createIssue();
    const run = await runs.create(issue.id, context, 'host');
    await runs.checkout(workspaceId, run.id);
    await issues.addComment(issue.id, 'user-a', 'Comment');
    await issues.update(workspaceId, issue.id, { assigneeAgentId: null });
    await runs.completeHost(workspaceId, run.id, { output: 'Done' });
    expect(await runs.list(workspaceId, issue.id)).toHaveLength(1);
    expect(executeAgent).not.toHaveBeenCalled();
  });
});

describe('RunService host runs', () => {
  it('rejects checkout of server runs and runs claimed concurrently', async () => {
    const executeAgent = vi.fn(() => new Promise(() => undefined));
    const { runs, store, createIssue } = setup({ executeAgent });
    const serverIssue = await createIssue('Server');
    const server = await runs.create(serverIssue.id, context);
    await expect(runs.checkout(workspaceId, server.id)).rejects.toMatchObject({
      code: 'INVALID_RUN_MODE',
    });
    const hostIssue = await createIssue('Host');
    const host = await runs.create(hostIssue.id, context, 'host');
    vi.spyOn(store, 'start').mockResolvedValueOnce(null);
    await expect(runs.checkout(workspaceId, host.id)).rejects.toMatchObject({
      code: 'INVALID_RUN_STATE',
    });
  });

  it('only completes checked-out host runs and prices reported usage', async () => {
    const { runs, store, createIssue } = setup({ managed: true });
    await runs.setRate({
      workspaceId,
      provider: 'anthropic',
      model: 'm',
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 4,
    });
    const issue = await createIssue();
    const run = await runs.create(issue.id, context, 'host');
    await expect(runs.completeHost(workspaceId, run.id, { output: 'x' })).rejects.toMatchObject({
      code: 'INVALID_RUN_STATE',
    });
    await runs.checkout(workspaceId, run.id);
    vi.spyOn(store, 'finish').mockResolvedValueOnce(null);
    await expect(runs.completeHost(workspaceId, run.id, { output: 'x' })).rejects.toMatchObject({
      code: 'INVALID_RUN_STATE',
    });
    const done = await runs.completeHost(workspaceId, run.id, {
      output: 'x',
      provider: 'Anthropic',
      model: 'm',
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(done).toMatchObject({ provider: 'Anthropic', costMicros: 40 });
  });

  it('prices nothing for invalid or overflowing usage', async () => {
    const { runs } = setup();
    await runs.setRate({
      workspaceId,
      provider: 'mcp',
      model: 'm',
      inputUsdPerMillion: 100_000,
      outputUsdPerMillion: 0,
    });
    const usage = { tool: 't', provider: 'mcp', model: 'm', estimated: true };
    for (const tokens of [
      { inputTokens: 1.5, outputTokens: 0 },
      { inputTokens: 0, outputTokens: 1.5 },
      { inputTokens: -1, outputTokens: 0 },
      { inputTokens: 0, outputTokens: -1 },
      { inputTokens: 1_000_000, outputTokens: 0 },
    ])
      expect((await runs.recordUsage(workspaceId, null, { ...usage, ...tokens })).costMicros).toBe(
        null,
      );
    expect(
      (await runs.recordUsage(workspaceId, null, { ...usage, inputTokens: 1, outputTokens: 0 }))
        .costMicros,
    ).toBe(100_000);
  });

  it('cancels only active runs and reports concurrent finishes', async () => {
    const { runs, store, issues, createIssue } = setup({ managed: true });
    const issue = await createIssue();
    const run = await runs.create(issue.id, context, 'host');
    vi.spyOn(store, 'finish').mockResolvedValueOnce(null);
    await expect(runs.cancel(workspaceId, run.id)).rejects.toMatchObject({
      code: 'INVALID_RUN_STATE',
    });
    expect((await runs.cancel(workspaceId, run.id)).status).toBe('cancelled');
    expect((await issues.get(workspaceId, issue.id))?.status).toBe('todo');
    await expect(runs.cancel(workspaceId, run.id)).rejects.toMatchObject({
      code: 'INVALID_RUN_STATE',
    });
  });

  it('summarizes costs per agent including unpriced and old runs', async () => {
    const { runs, store } = setup();
    const now = new Date();
    const runsList: AgentRun[] = [
      { agentId: 'a', status: 'succeeded', costMicros: null, createdAt: now },
      { agentId: 'a', status: 'succeeded', costMicros: 5, createdAt: now },
      { agentId: 'b', status: 'failed', costMicros: null, createdAt: now },
      { agentId: 'c', status: 'succeeded', costMicros: 9, createdAt: new Date(2000, 0, 1) },
    ].map((partial) => ({ inputTokens: null, outputTokens: null, ...partial }) as AgentRun);
    vi.spyOn(store, 'list').mockResolvedValue(runsList);
    const costs = await runs.costs(workspaceId);
    expect(costs).toMatchObject({
      monthSpendMicros: 5,
      unpricedRuns: 1,
      byAgent: {
        a: { spendMicros: 5, runs: 2, unpricedRuns: 1 },
        b: { spendMicros: 0, runs: 1, unpricedRuns: 0 },
      },
    });
    expect(costs.byAgent).not.toHaveProperty('c');
  });
});
