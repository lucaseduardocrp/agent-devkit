import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryIssueStore } from '../src/modules/issues/issue-store.js';
import { InMemoryRunStore, type AgentRun } from '../src/modules/issues/run-store.js';
import { RunService } from '../src/modules/issues/run-service.js';
import { InMemoryPbiStore } from '../src/modules/pbi/pbi-store.js';
import { InMemoryUsageStore } from '../src/modules/issues/usage-store.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import type { AgentWorkflow } from '../src/modules/agents/domain/agent-workflow.js';
import { fakeRunAgents } from './helpers/fake-run-agents.js';

const workspaceId = 'workspace-a';
const context = { requestId: 'test', workspaceId, ownerId: 'owner-a', actorId: 'user-a' };
const agentId = 'agent-a';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const COMMENT_PROMPT = 'The latest user comment [c] is a new request. Consider the issue.';

function setup(executeAgent: ReturnType<typeof vi.fn>, workflow: Partial<AgentWorkflow> = {}) {
  const issues = new InMemoryIssueStore();
  const store = new InMemoryRunStore();
  const pbi = new InMemoryPbiStore();
  const imageStore = new InMemoryE2eArtifactStore();
  const runs = new RunService(
    store,
    issues,
    fakeRunAgents(executeAgent, { workflow }),
    pbi,
    new InMemoryUsageStore(),
    imageStore,
  );
  return { issues, store, runs, pbi, imageStore };
}

const settled = (store: InMemoryRunStore, runId: string, status: AgentRun['status']) =>
  vi.waitFor(async () => {
    const run = await store.get(workspaceId, runId);
    expect(run?.status).toBe(status);
    return run!;
  });

afterEach(() => vi.restoreAllMocks());

describe('RunService PBI context', () => {
  it('lists each descendant once when the imported hierarchy is cyclic', async () => {
    const execute = vi.fn().mockResolvedValue({ result: 'ok', provider: 'H' });
    const { runs, store, issues, pbi } = setup(execute, { finalReview: false });
    const root = await pbi.create(workspaceId, { kind: 'pbi', title: 'Root', description: 'R' });
    const child = await pbi.create(workspaceId, {
      kind: 'card',
      title: 'Child',
      description: 'C',
      parentId: root.id,
    });
    await pbi.update(workspaceId, root.id, { parentId: child.id });
    const issue = await issues.create(workspaceId, 'u', {
      title: 'Cyclic',
      assigneeAgentId: agentId,
      pbiItemId: root.id,
    });
    const run = await runs.create(issue.id, context);
    expect(run.prompt).toContain('Current PBI context:\nRoot: R\n- Child: C\n  - Root: R\n');
    await settled(store, run.id, 'succeeded');
  });

  it('accepts issues and PBI items stored without attachment lists', async () => {
    const execute = vi.fn().mockResolvedValue({ result: 'ok', provider: 'H' });
    const { runs, store, issues, pbi, imageStore } = setup(execute, { finalReview: false });
    await imageStore.put(`images/pbi/${workspaceId}/img.png`, PNG);
    const root = await pbi.create(workspaceId, { kind: 'pbi', title: 'Root' });
    const child = await pbi.create(workspaceId, {
      kind: 'card',
      title: 'Child',
      parentId: root.id,
      description: '![shot](/attachments/files/11111111-1111-4111-8111-111111111111)',
    });
    await pbi.update(workspaceId, root.id, { parentId: child.id });
    const bare = <T extends { attachments?: unknown }>(value: T) => ({
      ...value,
      attachments: undefined,
    });
    const list = pbi.list.bind(pbi);
    vi.spyOn(pbi, 'get').mockResolvedValue(bare(root));
    vi.spyOn(pbi, 'list').mockImplementation(async (ws) => (await list(ws)).map(bare));
    const issue = await issues.create(workspaceId, 'u', {
      title: 'Bare',
      assigneeAgentId: agentId,
      pbiItemId: root.id,
    });
    const get = issues.get.bind(issues);
    vi.spyOn(issues, 'get').mockImplementation(async (ws, id) => {
      const found = await get(ws, id);
      return found && bare(found);
    });
    const run = await runs.create(issue.id, context);
    expect(run.prompt).toContain('Attached images for visual context:\n- shot');
    await settled(store, run.id, 'succeeded');
  });
});

describe('RunService runs created before workflows', () => {
  async function legacy(prompt = 'Do it') {
    const execute = vi.fn();
    const env = setup(execute);
    const issue = await env.issues.create(workspaceId, 'u', {
      title: 'Legacy',
      assigneeAgentId: agentId,
      attachments: [
        {
          id: 'img',
          name: 'img.png',
          mimeType: 'image/png',
          scope: 'issue',
          source: 'adk',
          url: '/attachments/files/img',
        },
      ],
    });
    await env.imageStore.put(`images/issue/${workspaceId}/img.png`, PNG);
    const run = (await env.store.claim({
      workspaceId,
      issueId: issue.id,
      agentId,
      actorId: 'u',
      ownerId: 'o',
      mode: 'server',
      prompt,
      attempt: 1,
    }))!;
    return { ...env, execute, issue, run };
  }

  it('runs the assigned agent with images and replies to comment requests', async () => {
    const { runs, store, issues, execute, issue, run } = await legacy(COMMENT_PROMPT);
    execute.mockResolvedValue({ result: 'Reply', provider: 'Host' });
    await runs.recover();
    const finished = await settled(store, run.id, 'succeeded');
    expect(finished).toMatchObject({ model: null, inputTokens: null, outputTokens: null });
    expect(execute.mock.calls[0]![2]).toMatchObject({
      prompt: COMMENT_PROMPT,
      images: [{ mimeType: 'image/png', data: PNG.toString('base64') }],
    });
    await vi.waitFor(async () =>
      expect((await issues.comments(issue.id)).map((comment) => comment.body)).toEqual(['Reply']),
    );
    expect((await issues.get(workspaceId, issue.id))!.status).toBe('in_review');
  });

  it('records the model, tokens and cost reported by a legacy run', async () => {
    const { runs, store, execute, run } = await legacy();
    await runs.setRate({
      workspaceId,
      provider: 'openai',
      model: 'm',
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
    });
    execute.mockResolvedValue({
      result: 'Done',
      provider: 'OpenAI',
      model: 'm',
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    await runs.recover();
    expect(await settled(store, run.id, 'succeeded')).toMatchObject({
      output: 'Done',
      model: 'm',
      inputTokens: 10,
      outputTokens: 20,
      costMicros: 50,
    });
  });

  it('ignores the result of a legacy run cancelled while the agent works', async () => {
    const { runs, store, execute, run } = await legacy();
    let release!: (value: object) => void;
    execute.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    await runs.recover();
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    await runs.cancel(workspaceId, run.id);
    release({ result: 'late', provider: 'H' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await store.get(workspaceId, run.id)).toMatchObject({
      status: 'cancelled',
      output: null,
    });
  });

  it('keeps a cancelled legacy run cancelled when the agent then fails', async () => {
    const { runs, store, execute, run, issues } = await legacy();
    let fail!: (error: Error) => void;
    execute.mockImplementation(() => new Promise((_resolve, reject) => (fail = reject)));
    await runs.recover();
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    await runs.cancel(workspaceId, run.id);
    fail(new Error('aborted by the user'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await store.get(workspaceId, run.id)).toMatchObject({
      status: 'cancelled',
      error: null,
    });
    expect((await issues.get(workspaceId, run.issueId))?.status).not.toBe('blocked');
  });

  it('leaves the issue alone when a successful legacy run was already closed', async () => {
    const { runs, store, execute, run, issues } = await legacy();
    execute.mockResolvedValue({ result: 'done', provider: 'H' });
    vi.spyOn(store, 'finish').mockResolvedValue(null);
    await runs.recover();
    await vi.waitFor(() => expect(store.finish).toHaveBeenCalled());
    expect((await issues.get(workspaceId, run.issueId))?.status).not.toBe('in_review');
  });

  it('leaves the issue alone when a failed legacy run was already closed', async () => {
    const { runs, store, execute, run, issues } = await legacy();
    execute.mockRejectedValue(new Error('provider down'));
    vi.spyOn(store, 'finish').mockResolvedValue(null);
    await runs.recover();
    await vi.waitFor(() => expect(store.finish).toHaveBeenCalled());
    expect((await issues.get(workspaceId, run.issueId))?.status).not.toBe('blocked');
  });
});

describe('RunService workflow interruptions', () => {
  it('stops before the next step when the run is cancelled between steps', async () => {
    const execute = vi.fn().mockResolvedValue({ result: 'ok', provider: 'H' });
    const { runs, store, issues } = setup(execute, {
      enabled: true,
      finalReview: false,
      steps: [
        { id: 'a', name: 'A', instructions: '' },
        { id: 'b', name: 'B', instructions: '' },
      ],
    });
    const progress = store.progress.bind(store);
    vi.spyOn(store, 'progress').mockImplementationOnce(async (ws, id, ...rest) => {
      await runs.cancel(ws, id);
      return progress(ws, id, ...rest);
    });
    const issue = await issues.create(workspaceId, 'u', { title: 'T', assigneeAgentId: agentId });
    const run = await runs.create(issue.id, context);
    await settled(store, run.id, 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('logs a resumed workflow that cannot start', async () => {
    const execute = vi.fn().mockResolvedValue({ result: 'ok', provider: 'H' });
    const { runs, store, issues } = setup(execute, {
      enabled: true,
      steps: [{ id: 'a', name: 'A', instructions: '', reviewRequired: true }],
    });
    const issue = await issues.create(workspaceId, 'u', { title: 'T', assigneeAgentId: agentId });
    const run = await runs.create(issue.id, context);
    await settled(store, run.id, 'waiting_review');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(store, 'start').mockRejectedValueOnce(new Error('db down'));
    await runs.continueWorkflow(workspaceId, run.id, { action: 'revise', answer: 'redo' });
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith('[RunService] Workflow resume failed:', expect.any(Error)),
    );
  });
});
