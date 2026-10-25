import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryIssueStore } from '../src/modules/issues/issue-store.js';
import { InMemoryRunStore, type AgentRun, type RunStore } from '../src/modules/issues/run-store.js';
import { RunService } from '../src/modules/issues/run-service.js';
import { InMemoryPbiStore } from '../src/modules/pbi/pbi-store.js';
import { InMemoryUsageStore } from '../src/modules/issues/usage-store.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import type { AgentWorkflow } from '../src/modules/agents/domain/agent-workflow.js';
import { ApplicationError } from '../src/shared/errors.js';
import { fakeRunAgents } from './helpers/fake-run-agents.js';

const workspaceId = 'workspace-a';
const context = { requestId: 'test', workspaceId, ownerId: 'owner-a', actorId: 'user-a' };
const agentId = 'agent-a';
const usage = { inputTokens: 1000, outputTokens: 500 };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

function managed(store: InMemoryRunStore): RunStore {
  const view = Object.create(store) as RunStore;
  Object.defineProperty(view, 'managesIssueStatus', { value: true });
  return view;
}

function setup(
  executeAgent: ReturnType<typeof vi.fn>,
  workflow: Partial<AgentWorkflow> = {},
  options: { managed?: boolean; images?: boolean } = {},
) {
  const issues = new InMemoryIssueStore();
  const memory = new InMemoryRunStore();
  const pbi = new InMemoryPbiStore();
  const imageStore = options.images ? new InMemoryE2eArtifactStore() : undefined;
  const agents = fakeRunAgents(executeAgent, { workflow });
  const runs = new RunService(
    options.managed ? managed(memory) : memory,
    issues,
    agents,
    pbi,
    new InMemoryUsageStore(),
    imageStore,
  );
  return { issues, store: memory, runs, agents, pbi, imageStore };
}

const settled = (store: InMemoryRunStore, runId: string, status: AgentRun['status']) =>
  vi.waitFor(async () => {
    const run = await store.get(workspaceId, runId);
    expect(run?.status).toBe(status);
    return run!;
  });

const prompts = (execute: ReturnType<typeof vi.fn>) =>
  execute.mock.calls.map((call) => (call[2] as { prompt: string }).prompt);

afterEach(() => vi.restoreAllMocks());

describe('RunService multi-step workflow', () => {
  it('asks, takes an answer, revises, reviews and finishes with aggregated costs', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        result: '[[ADK_QUESTION]] Which environment?',
        provider: 'OpenAI',
        model: 'm',
        usage,
      })
      .mockResolvedValueOnce({ result: 'Plan v1', provider: 'OpenAI', model: 'm', usage })
      .mockResolvedValueOnce({ result: 'Plan v2', provider: 'OpenAI', model: 'm', usage })
      .mockResolvedValueOnce({ result: ' Built ', provider: 'OpenAI', model: 'm', usage });
    const { runs, store, issues } = setup(execute, {
      enabled: true,
      finalReview: true,
      steps: [
        { id: 's1', name: 'Plan', instructions: 'plan', reviewRequired: true },
        { id: 's2', name: 'Build', instructions: 'build' },
      ],
    });
    await runs.setRate({
      workspaceId,
      provider: 'openai',
      model: 'm',
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 4,
    });
    const issue = await issues.create(workspaceId, 'user-a', {
      title: 'Task',
      assigneeAgentId: agentId,
    });
    const run = await runs.create(issue.id, context);
    expect(run.workflowState).toMatchObject({ enabled: true, currentStepIndex: 0 });

    const asking = await settled(store, run.id, 'waiting_input');
    expect(asking.workflowState).toMatchObject({
      question: 'Which environment?',
      currentStepIndex: 0,
      totalCostMicros: 4000,
    });
    expect(asking).toMatchObject({ inputTokens: 1000, outputTokens: 500, costMicros: 4000 });
    expect(asking.output).toContain('## Plan · Pergunta\n\nWhich environment?');
    expect((await issues.get(workspaceId, issue.id))!.status).toBe('in_review');

    await expect(
      runs.continueWorkflow(workspaceId, run.id, { action: 'approve' }),
    ).rejects.toMatchObject({ code: 'INVALID_RUN_STATE' });
    await expect(
      runs.continueWorkflow(workspaceId, run.id, { action: 'answer', answer: '  ' }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_ANSWER_REQUIRED' });
    const resumed = await runs.continueWorkflow(workspaceId, run.id, {
      action: 'answer',
      answer: ' staging ',
    });
    expect(resumed.status).toBe('queued');
    expect(resumed.workflowState).toMatchObject({ answer: 'staging', question: undefined });
    expect((await issues.get(workspaceId, issue.id))!.status).toBe('in_progress');

    const reviewing = await settled(store, run.id, 'waiting_review');
    expect(prompts(execute)[1]).toContain('<user-response>\nstaging\n</user-response>');
    expect(reviewing.workflowState).toMatchObject({ currentStepIndex: 1 });
    await expect(
      runs.continueWorkflow(workspaceId, run.id, { action: 'answer', answer: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_RUN_STATE' });

    await runs.continueWorkflow(workspaceId, run.id, { action: 'revise', answer: 'More detail' });
    const revised = await vi.waitFor(async () => {
      const current = (await store.get(workspaceId, run.id))!;
      expect(current.status).toBe('waiting_review');
      expect(execute).toHaveBeenCalledTimes(3);
      return current;
    });
    expect(prompts(execute)[2]).toContain('More detail');
    expect(revised.workflowState!.results.map((result) => result.name)).toContain(
      'Pedido de revisão',
    );

    await runs.continueWorkflow(workspaceId, run.id, { action: 'approve' });
    const final = await vi.waitFor(async () => {
      const current = (await store.get(workspaceId, run.id))!;
      expect(execute).toHaveBeenCalledTimes(4);
      expect(current.status).toBe('waiting_review');
      return current;
    });
    expect(prompts(execute)[3]).toContain('Resultados das etapas anteriores');
    expect(prompts(execute)[3]).toContain('Plan v2');
    expect(prompts(execute)[3]).not.toContain('Which environment?');
    expect(final.workflowState).toMatchObject({ currentStepIndex: 2 });

    const finished = await runs.continueWorkflow(workspaceId, run.id, { action: 'approve' });
    expect(finished).toMatchObject({
      status: 'succeeded',
      provider: 'OpenAI',
      model: 'm',
      inputTokens: 4000,
      outputTokens: 2000,
      costMicros: 16000,
    });
    expect(finished.output).toContain('## Resposta do usuário · Resposta do usuário\n\nstaging');
    expect(finished.output).toContain('## Build\n\nBuilt');
    expect((await issues.get(workspaceId, issue.id))!.status).toBe('done');
    await expect(
      runs.continueWorkflow(workspaceId, run.id, { action: 'approve' }),
    ).rejects.toMatchObject({ code: 'INVALID_RUN_STATE' });
  });

  it('uses a default question and leaves unpriced usage empty', async () => {
    const execute = vi.fn().mockResolvedValue({ result: '[[ADK_QUESTION]]', provider: 'Host' });
    const { runs, store, issues } = setup(execute, {
      enabled: true,
      steps: [{ id: 's1', name: 'Only', instructions: '' }],
    });
    const issue = await issues.create(workspaceId, 'u', { title: 'T', assigneeAgentId: agentId });
    const run = await runs.create(issue.id, context);
    const waiting = await settled(store, run.id, 'waiting_input');
    expect(waiting.workflowState!.question).toBe(
      'O agente precisa de uma informação para continuar.',
    );
    expect(waiting).toMatchObject({ model: null, inputTokens: null, costMicros: null });
    expect(waiting.workflowState!.results[0]).not.toHaveProperty('model');
  });

  it('pauses after every step in supervised mode and finishes without final review', async () => {
    const execute = vi.fn().mockResolvedValue({ result: 'ok', provider: 'Host' });
    const { runs, store, issues } = setup(
      execute,
      {
        enabled: true,
        autonomy: 'supervised',
        finalReview: false,
        steps: [
          { id: 'a', name: 'A', instructions: '' },
          { id: 'b', name: 'B', instructions: '' },
        ],
      },
      { managed: true },
    );
    const issue = await issues.create(workspaceId, 'u', { title: 'T', assigneeAgentId: agentId });
    const run = await runs.create(issue.id, context);
    await settled(store, run.id, 'waiting_review');
    expect(execute).toHaveBeenCalledTimes(1);
    await runs.continueWorkflow(workspaceId, run.id, { action: 'approve' });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    const paused = await settled(store, run.id, 'waiting_review');
    expect(paused.workflowState!.currentStepIndex).toBe(2);
    const done = await runs.continueWorkflow(workspaceId, run.id, { action: 'approve' });
    expect(done).toMatchObject({
      status: 'succeeded',
      provider: 'Host',
      inputTokens: null,
      outputTokens: null,
      costMicros: null,
    });
    // The managed store owns issue status, so the in-memory issue is never touched.
    expect((await issues.get(workspaceId, issue.id))!.status).toBe('todo');
  });

  it('finishes without review and replies with the workflow output to comment requests', async () => {
    const execute = vi.fn().mockResolvedValue({ result: 'Answer', provider: 'Host' });
    const { runs, store, issues } = setup(execute, {
      enabled: true,
      finalReview: false,
      steps: [{ id: 'a', name: 'Reply', instructions: '' }],
    });
    const issue = await issues.create(workspaceId, 'u', {
      title: 'T',
      assigneeAgentId: agentId,
      status: 'done',
    });
    const comment = await issues.addComment(issue.id, 'user-a', 'Please check');
    const run = await runs.create(issue.id, context, 'server', comment);
    await settled(store, run.id, 'succeeded');
    await vi.waitFor(async () =>
      expect((await issues.comments(issue.id)).map((item) => item.body)).toEqual([
        'Please check',
        '## Reply\n\nAnswer',
      ]),
    );
  });

  it('rejects resuming host runs, legacy runs and runs that finished meanwhile', async () => {
    const { runs, store, issues } = setup(vi.fn());
    const issue = await issues.create(workspaceId, 'u', { title: 'T', assigneeAgentId: agentId });
    const host = await runs.create(issue.id, context, 'host');
    await expect(
      runs.continueWorkflow(workspaceId, host.id, { action: 'approve' }),
    ).rejects.toMatchObject({ code: 'INVALID_RUN_MODE' });
    await store.finish(workspaceId, host.id, 'cancelled', {});

    const legacy = (await store.claim({
      workspaceId,
      issueId: issue.id,
      agentId,
      actorId: 'u',
      ownerId: 'o',
      mode: 'server',
      prompt: 'p',
      attempt: 2,
    }))!;
    await expect(
      runs.continueWorkflow(workspaceId, legacy.id, { action: 'approve' }),
    ).rejects.toBeInstanceOf(ApplicationError);
    await store.finish(workspaceId, legacy.id, 'cancelled', {});

    const state = {
      enabled: true,
      autonomy: 'balanced' as const,
      finalReview: true,
      uncertaintyBehavior: 'ask' as const,
      issueCreationBehavior: 'ask' as const,
      steps: [{ id: 's', name: 'S', instructions: '' }],
      currentStepIndex: 0,
      results: [],
      totalCostMicros: 0,
      allStepsPriced: true,
    };
    const paused = (await store.claim({
      workspaceId,
      issueId: issue.id,
      agentId,
      actorId: 'u',
      ownerId: 'o',
      mode: 'server',
      prompt: 'p',
      attempt: 3,
      workflowState: state,
    }))!;
    await store.start(workspaceId, paused.id);
    await store.checkpoint(workspaceId, paused.id, 'waiting_review', state, '');
    vi.spyOn(store, 'resume').mockResolvedValueOnce(null);
    await expect(
      runs.continueWorkflow(workspaceId, paused.id, { action: 'revise', answer: 'again' }),
    ).rejects.toMatchObject({ code: 'INVALID_RUN_STATE' });
    await expect(
      runs.continueWorkflow(workspaceId, paused.id, { action: 'revise' }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_ANSWER_REQUIRED' });

    await store.checkpoint(workspaceId, paused.id, 'waiting_review', state, '');
    const done = { ...state, currentStepIndex: 1 };
    const finished = (await store.claim({
      workspaceId,
      issueId: 'other',
      agentId,
      actorId: 'u',
      ownerId: 'o',
      mode: 'server',
      prompt: 'p',
      attempt: 1,
      workflowState: done,
    }))!;
    await store.start(workspaceId, finished.id);
    await store.checkpoint(workspaceId, finished.id, 'waiting_review', done, '');
    vi.spyOn(store, 'finish').mockResolvedValueOnce(null);
    await expect(
      runs.continueWorkflow(workspaceId, finished.id, { action: 'approve' }),
    ).rejects.toMatchObject({ code: 'INVALID_RUN_STATE', message: 'Run already finished.' });
  });

  it('rejects revisions when the run is waiting for an answer', async () => {
    const execute = vi.fn().mockResolvedValue({ result: '[[ADK_QUESTION]] Why?', provider: 'H' });
    const { runs, store, issues } = setup(execute, {
      enabled: true,
      steps: [{ id: 's', name: 'S', instructions: '' }],
    });
    const issue = await issues.create(workspaceId, 'u', { title: 'T', assigneeAgentId: agentId });
    const run = await runs.create(issue.id, context);
    await settled(store, run.id, 'waiting_input');
    await expect(
      runs.continueWorkflow(workspaceId, run.id, { action: 'revise', answer: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_RUN_STATE' });
  });

  it('stops quietly when the run is cancelled during a workflow step', async () => {
    let release!: (value: object) => void;
    const execute = vi.fn(
      () =>
        new Promise<object>((resolve) => {
          release = resolve;
        }),
    );
    const { runs, store, issues } = setup(execute, {
      enabled: true,
      steps: [{ id: 's', name: 'S', instructions: '' }],
    });
    const issue = await issues.create(workspaceId, 'u', { title: 'T', assigneeAgentId: agentId });
    const run = await runs.create(issue.id, context);
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    await runs.cancel(workspaceId, run.id);
    const progress = vi.spyOn(store, 'progress');
    release({ result: 'late', provider: 'H' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(progress).not.toHaveBeenCalled();
    expect((await store.get(workspaceId, run.id))!.status).toBe('cancelled');
  });
});

describe('RunService image attachments', () => {
  it('sends issue, PBI and descendant images to every workflow step', async () => {
    const execute = vi.fn().mockResolvedValue({ result: 'ok', provider: 'H' });
    const { runs, store, issues, pbi, imageStore } = setup(
      execute,
      { finalReview: false },
      { images: true },
    );
    const image = (id: string, scope: 'issue' | 'pbi') => ({
      id,
      name: `${id}.png`,
      mimeType: 'image/png',
      scope,
      source: 'adk' as const,
      url: `/attachments/files/${id}`,
    });
    for (const [id, scope] of [
      ['img-issue', 'issue'],
      ['img-root', 'pbi'],
      ['img-child', 'pbi'],
    ] as const)
      await imageStore!.put(`images/${scope}/${workspaceId}/${id}.png`, PNG);
    const root = await pbi.create(workspaceId, {
      kind: 'pbi',
      title: 'Root',
      attachments: [image('img-root', 'pbi')],
    });
    const child = await pbi.create(workspaceId, {
      kind: 'card',
      title: 'Child',
      parentId: root.id,
      attachments: [image('img-child', 'pbi')],
    });
    await pbi.create(workspaceId, { kind: 'card', title: 'Grandchild', parentId: child.id });
    await pbi.create(workspaceId, { kind: 'pbi', title: 'Unrelated' });
    const issue = await issues.create(workspaceId, 'u', {
      title: 'With images',
      assigneeAgentId: agentId,
      pbiItemId: root.id,
      attachments: [image('img-issue', 'issue')],
    });
    const run = await runs.create(issue.id, context);
    expect(run.prompt).toContain(
      'Attached images for visual context:\n- img-issue.png\n- img-root.png\n- img-child.png',
    );
    await settled(store, run.id, 'succeeded');
    const input = execute.mock.calls[0]![2] as { images: { mimeType: string; data: string }[] };
    expect(input.images).toHaveLength(3);
    expect(input.images[0]).toEqual({ mimeType: 'image/png', data: PNG.toString('base64') });
  });

  it('sends no images when the issue or its PBI item is gone', async () => {
    const execute = vi.fn().mockResolvedValue({ result: 'ok', provider: 'H' });
    const { runs, store, issues } = setup(execute, { finalReview: false }, { images: true });
    const issue = await issues.create(workspaceId, 'u', {
      title: 'Orphan',
      assigneeAgentId: agentId,
      pbiItemId: 'missing',
    });
    const run = await runs.create(issue.id, context);
    await settled(store, run.id, 'succeeded');
    expect(execute.mock.calls[0]![2]).not.toHaveProperty('images');

    const gone = await issues.create(workspaceId, 'u', { title: 'Gone', assigneeAgentId: agentId });
    const getIssue = issues.get.bind(issues);
    let lookups = 0;
    // The issue disappears after the run is created.
    vi.spyOn(issues, 'get').mockImplementation(async (ws, id) =>
      id === gone.id && ++lookups > 1 ? null : getIssue(ws, id),
    );
    const second = await runs.create(gone.id, context);
    await settled(store, second.id, 'succeeded');
    expect(execute.mock.calls[1]![2]).not.toHaveProperty('images');
  });
});
