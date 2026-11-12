import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryIssueStore } from '../src/modules/issues/issue-store.js';
import {
  InMemoryRunStore,
  type AgentRun,
  type WorkflowRunState,
} from '../src/modules/issues/run-store.js';
import { RunService } from '../src/modules/issues/run-service.js';
import { InMemoryUsageStore } from '../src/modules/issues/usage-store.js';
import {
  AGENT_WORKFLOW_QUESTION_MARKER,
  type AgentWorkflow,
  type AgentWorkflowCanvasNode,
  type AgentWorkflowNodeKind,
  type AgentWorkflowStep,
} from '../src/modules/agents/domain/agent-workflow.js';
import type { PbiStore } from '../src/modules/pbi/pbi-store.js';
import type { E2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import { loadImageAttachments } from '../src/modules/shared/image-attachment.js';
import { fakeRunAgents } from './helpers/fake-run-agents.js';

vi.mock('../src/modules/shared/image-attachment.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/modules/shared/image-attachment.js')>()),
  loadImageAttachments: vi.fn(async () => []),
}));

const workspaceId = 'workspace-a';
const context = { requestId: 'test', workspaceId, ownerId: 'owner-a', actorId: 'user-a' };
const agentId = 'agent-a';

type StepOutcome =
  | string
  | {
      result: string;
      provider?: string;
      model?: string;
      usage?: { inputTokens: number; outputTokens: number };
    };

const step = (id: string, extra: Partial<AgentWorkflowStep> = {}): AgentWorkflowStep => ({
  id,
  name: `Step ${id}`,
  instructions: `Do ${id}`,
  ...extra,
});
const node = (
  id: string,
  kind: AgentWorkflowNodeKind,
  extra: Partial<AgentWorkflowCanvasNode> = {},
): AgentWorkflowCanvasNode => ({ id, kind, x: 0, y: 0, ...extra });
const edge = (from: string, to: string, fromPort?: 'true' | 'false') => ({
  id: `${from}-${to}-${fromPort ?? ''}`,
  from,
  to,
  ...(fromPort ? { fromPort } : {}),
});
const delay0 = (id = 'wait') => node(id, 'delay', { delay: { minutes: 0 } });
const trigger = node('start', 'trigger');

function setup(
  options: {
    workflow?: Partial<AgentWorkflow>;
    outcomes?: StepOutcome[];
    imageStore?: E2eArtifactStore;
    pbiItems?: PbiStore;
    notifications?: { sendForIssue: ReturnType<typeof vi.fn> };
    /** A store that owns the issue status transitions, like the Prisma store. */
    managed?: boolean;
  } = {},
) {
  const issues = new InMemoryIssueStore();
  const store = new InMemoryRunStore();
  const serving = options.managed
    ? Object.defineProperty(Object.create(store) as InMemoryRunStore, 'managesIssueStatus', {
        value: true,
      })
    : store;
  const queue = [...(options.outcomes ?? [])];
  const agents = fakeRunAgents(vi.fn(), {
    enabled: true,
    ...options.workflow,
  });
  agents.executeWorkflowStep.mockImplementation(async (_ws: string, stepAgentId: string) => {
    const next = queue.shift() ?? 'Step output';
    const outcome = typeof next === 'string' ? { result: next } : next;
    return { agent: { id: stepAgentId }, provider: 'OpenAI', ...outcome };
  });
  const runs = new RunService(
    serving,
    issues,
    agents,
    options.pbiItems,
    new InMemoryUsageStore(),
    options.imageStore,
    undefined,
    options.notifications as never,
  );
  const createIssue = (title = 'Task', extra: Record<string, unknown> = {}) =>
    issues.create(workspaceId, 'user-a', { title, assigneeAgentId: agentId, ...extra });
  const waitFor = (runId: string, status: AgentRun['status']) =>
    vi.waitFor(async () => expect((await runs.get(workspaceId, runId)).status).toBe(status));
  /** Creates an issue and starts a server run for it. */
  const start = async (title = 'Task') => {
    const issue = await createIssue(title);
    const run = await runs.create(issue.id, context);
    return { issue, run };
  };
  const state = async (runId: string): Promise<WorkflowRunState> =>
    (await runs.get(workspaceId, runId)).workflowState!;
  return { issues, store, runs, agents, createIssue, waitFor, start, state, queue };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(loadImageAttachments).mockReset().mockResolvedValue([]);
});

describe('RunService step workflows', () => {
  it('pauses on a question, resumes with the answer and finishes after the final review', async () => {
    const { runs, issues, agents, start, waitFor, state } = setup({
      workflow: { steps: [step('a'), step('b')], finalReview: true },
      outcomes: [
        { result: `${AGENT_WORKFLOW_QUESTION_MARKER} Which environment?`, model: 'm' },
        { result: 'A done', model: 'm', usage: { inputTokens: 10, outputTokens: 5 } },
        { result: 'B done', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
    });
    const { run, issue } = await start();
    await waitFor(run.id, 'waiting_input');
    expect((await state(run.id)).question).toBe('Which environment?');
    expect((await runs.get(workspaceId, run.id)).output).toContain('## Step a · Pergunta');
    expect((await issues.get(workspaceId, issue.id))?.status).toBe('in_review');

    await runs.continueWorkflow(workspaceId, run.id, { action: 'answer', answer: ' staging ' });
    await waitFor(run.id, 'waiting_review');
    const answered = agents.executeWorkflowStep.mock.calls[1]?.[5] as { prompt: string };
    expect(answered.prompt).toContain('<user-response>\nstaging\n</user-response>');
    const output = (await runs.get(workspaceId, run.id)).output!;
    expect(output).toContain('## Resposta do usuário · Resposta do usuário');
    expect(output).toContain('## Step b\n\nB done');
    const secondStep = agents.executeWorkflowStep.mock.calls[2]?.[5] as { prompt: string };
    expect(secondStep.prompt).toContain('Resultados das etapas anteriores');
    expect(secondStep.prompt).toContain('A done');

    const finished = await runs.continueWorkflow(workspaceId, run.id, { action: 'approve' });
    expect(finished.status).toBe('succeeded');
    expect(finished).toMatchObject({ inputTokens: 11, outputTokens: 6, model: null });
    expect((await issues.get(workspaceId, issue.id))?.status).toBe('done');
  });

  it('leaves the issue status to a managing store when pausing and resuming', async () => {
    const { runs, issues, start, waitFor } = setup({
      managed: true,
      workflow: { steps: [step('a')], finalReview: true },
      outcomes: [{ result: `${AGENT_WORKFLOW_QUESTION_MARKER} Which one?` }, 'A done'],
    });
    const { run, issue } = await start();
    await waitFor(run.id, 'waiting_input');
    await runs.continueWorkflow(workspaceId, run.id, { action: 'answer', answer: 'this one' });
    await waitFor(run.id, 'waiting_review');
    expect((await issues.get(workspaceId, issue.id))?.status).toBe('todo');
  });

  it('prices a step that ends in a question', async () => {
    const { runs, start, waitFor } = setup({
      workflow: { steps: [step('a')] },
      outcomes: [
        {
          result: `${AGENT_WORKFLOW_QUESTION_MARKER} Which one?`,
          model: 'm',
          usage: { inputTokens: 1000, outputTokens: 0 },
        },
      ],
    });
    await runs.setRate({
      workspaceId,
      provider: 'OpenAI',
      model: 'm',
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 0,
    });
    const { run } = await start();
    await waitFor(run.id, 'waiting_input');
    expect((await runs.get(workspaceId, run.id)).costMicros).toBe(5000);
  });

  it('uses a default question when the agent asks nothing specific', async () => {
    const { start, waitFor, state } = setup({
      workflow: { steps: [step('a')] },
      outcomes: [AGENT_WORKFLOW_QUESTION_MARKER],
    });
    const { run } = await start();
    await waitFor(run.id, 'waiting_input');
    expect((await state(run.id)).question).toBe(
      'O agente precisa de uma informação para continuar.',
    );
  });

  it('pauses after a step that needs review, then continues with the next one', async () => {
    const { runs, start, waitFor, state } = setup({
      workflow: { steps: [step('a', { reviewRequired: true }), step('b')], finalReview: false },
      outcomes: [{ result: 'A done', provider: 'Gemini' }, 'B done'],
    });
    const { run } = await start();
    await waitFor(run.id, 'waiting_review');
    expect((await state(run.id)).currentStepIndex).toBe(1);
    await runs.continueWorkflow(workspaceId, run.id, { action: 'approve' });
    await waitFor(run.id, 'succeeded');
    const done = await runs.get(workspaceId, run.id);
    expect(done).toMatchObject({ provider: 'OpenAI', inputTokens: null, outputTokens: null });
    expect(done.output).toContain('## Step b\n\nB done');
  });

  it('prices every step when rates exist and leaves the cost open otherwise', async () => {
    const { runs, start, waitFor } = setup({
      workflow: { steps: [step('a'), step('b')], finalReview: false },
      outcomes: [
        { result: 'one', model: 'm', usage: { inputTokens: 1000, outputTokens: 0 } },
        { result: 'two', model: 'other', usage: { inputTokens: 1000, outputTokens: 0 } },
      ],
    });
    await runs.setRate({
      workspaceId,
      provider: 'OpenAI',
      model: 'm',
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 0,
    });
    const { run } = await start();
    await waitFor(run.id, 'succeeded');
    const done = await runs.get(workspaceId, run.id);
    expect(done.costMicros).toBeNull();
    expect((await runs.costs(workspaceId)).unpricedRuns).toBe(1);
  });

  it('refuses to continue runs that cannot be resumed here or are in another state', async () => {
    const { runs, agents, createIssue, start, waitFor } = setup({
      workflow: { steps: [step('a')] },
    });
    const hostIssue = await createIssue('Host');
    const host = await runs.create(hostIssue.id, context, 'host');
    await expect(
      runs.continueWorkflow(workspaceId, host.id, { action: 'approve' }),
    ).rejects.toMatchObject({ code: 'INVALID_RUN_MODE' });

    agents.executeWorkflowStep.mockReturnValue(new Promise(() => undefined));
    const { run } = await start('Running');
    await vi.waitFor(async () =>
      expect((await runs.get(workspaceId, run.id)).status).toBe('running'),
    );
    for (const input of [
      { action: 'approve' as const },
      { action: 'answer' as const, answer: 'x' },
      { action: 'revise' as const, answer: 'x' },
    ])
      await expect(runs.continueWorkflow(workspaceId, run.id, input)).rejects.toMatchObject({
        code: 'INVALID_RUN_STATE',
      });
    await runs.cancel(workspaceId, run.id);
    await waitFor(run.id, 'cancelled');
  });

  it('requires a response to revise or answer, and rejects runs finished meanwhile', async () => {
    const { runs, store, start, waitFor } = setup({
      workflow: { steps: [step('a'), step('b')], finalReview: true },
      outcomes: ['A', 'B'],
    });
    const { run } = await start();
    await waitFor(run.id, 'waiting_review');
    await expect(
      runs.continueWorkflow(workspaceId, run.id, { action: 'revise' }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_ANSWER_REQUIRED' });
    await expect(
      runs.continueWorkflow(workspaceId, run.id, { action: 'revise', answer: '  ' }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_ANSWER_REQUIRED' });

    vi.spyOn(store, 'resume').mockResolvedValueOnce(null);
    await expect(
      runs.continueWorkflow(workspaceId, run.id, { action: 'revise', answer: 'again' }),
    ).rejects.toMatchObject({ code: 'INVALID_RUN_STATE' });

    vi.spyOn(store, 'finish').mockResolvedValueOnce(null);
    await expect(
      runs.continueWorkflow(workspaceId, run.id, { action: 'approve' }),
    ).rejects.toMatchObject({ code: 'INVALID_RUN_STATE' });
  });

  it('re-runs the step under review when a revision is requested', async () => {
    const { runs, start, waitFor, state, agents } = setup({
      workflow: { steps: [step('a'), step('b')], finalReview: true },
      outcomes: ['A', 'B', 'B again'],
    });
    const { run } = await start();
    await waitFor(run.id, 'waiting_review');
    await runs.continueWorkflow(workspaceId, run.id, { action: 'revise', answer: 'Shorter' });
    await waitFor(run.id, 'waiting_review');
    expect(agents.executeWorkflowStep).toHaveBeenCalledTimes(3);
    const results = (await state(run.id)).results;
    expect(results.map((result) => result.name)).toEqual([
      'Step a',
      'Step b',
      'Pedido de revisão',
      'Step b',
    ]);
    expect(results[2]).toMatchObject({ stepId: 'b', kind: 'answer', output: 'Shorter' });
  });

  it('logs a resumed run that fails to start', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { runs, store, start, waitFor } = setup({
      workflow: { steps: [step('a')], finalReview: true },
    });
    const { run } = await start();
    await waitFor(run.id, 'waiting_review');
    vi.spyOn(store, 'start').mockRejectedValueOnce(new Error('database down'));
    await runs.continueWorkflow(workspaceId, run.id, { action: 'revise', answer: 'Again' });
    await vi.waitFor(() =>
      expect(errors).toHaveBeenCalledWith(
        '[RunService] Workflow resume failed:',
        expect.any(Error),
      ),
    );
  });

  it('leaves a run alone when it was cancelled while a step ran', async () => {
    let finish!: (value: unknown) => void;
    const { runs, issues, agents, start, waitFor } = setup({
      workflow: { steps: [step('a')], finalReview: false },
    });
    agents.executeWorkflowStep.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { run, issue } = await start();
    await vi.waitFor(() => expect(agents.executeWorkflowStep).toHaveBeenCalledOnce());
    await runs.cancel(workspaceId, run.id);
    finish({ agent: { id: agentId }, result: 'late', provider: 'OpenAI' });
    await waitFor(run.id, 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await issues.get(workspaceId, issue.id))?.status).toBe('todo');
  });

  it('answers a comment with the whole workflow output', async () => {
    const { runs, issues, createIssue, waitFor } = setup({
      workflow: { steps: [step('a')], finalReview: false },
      outcomes: ['First result', 'Reply text'],
    });
    const issue = await createIssue();
    const first = await runs.create(issue.id, context);
    await waitFor(first.id, 'succeeded');
    await issues.update(workspaceId, issue.id, { status: 'done' });
    const comment = await issues.addComment(issue.id, 'user-a', 'Please explain.');
    const reply = await runs.create(issue.id, context, 'server', comment);
    await waitFor(reply.id, 'succeeded');
    expect((await issues.comments(issue.id)).at(-1)).toMatchObject({
      authorId: agentId,
      body: '## Step a\n\nReply text',
    });
  });
});

describe('RunService flow workflows', () => {
  const flow = (nodes: AgentWorkflowCanvasNode[], edges: ReturnType<typeof edge>[]) => ({
    canvas: { nodes: [trigger, ...nodes], edges },
  });

  it('takes the branch a condition picks, skips deleted steps and passes through triggers', async () => {
    const { runs, start, waitFor } = setup({
      workflow: {
        steps: [step('s1'), step('s2'), step('s3')],
        finalReview: false,
        ...flow(
          [
            node('s1', 'step'),
            node('cond', 'condition', { condition: { operator: 'contains', value: 'OK' } }),
            node('ghost', 'step'),
            node('again', 'trigger'),
            node('s2', 'step'),
            node('s3', 'step'),
          ],
          [
            edge('start', 's1'),
            edge('s1', 'cond'),
            edge('cond', 'ghost', 'true'),
            edge('cond', 's3', 'false'),
            edge('ghost', 'again'),
            edge('again', 's2'),
          ],
        ),
      },
      outcomes: ['all ok'],
    });
    const { run } = await start();
    await waitFor(run.id, 'succeeded');
    const output = (await runs.get(workspaceId, run.id)).output!;
    expect(output).toContain('## Condição · Fluxo\n\nA comparação foi atendida.');
    expect(output).toContain('## Step s2');
    expect(output).not.toContain('## Step s3');
  });

  it('takes the false branch when the comparison fails', async () => {
    const { runs, start, waitFor } = setup({
      workflow: {
        steps: [step('s1'), step('s3')],
        finalReview: false,
        ...flow(
          [
            node('s1', 'step'),
            node('cond', 'condition', { condition: { operator: 'not-contains', value: 'ok' } }),
            node('s3', 'step'),
          ],
          [edge('start', 's1'), edge('s1', 'cond'), edge('cond', 's3', 'false')],
        ),
      },
      outcomes: ['all ok'],
    });
    const { run } = await start();
    await waitFor(run.id, 'succeeded');
    expect((await runs.get(workspaceId, run.id)).output).toContain(
      'A comparação não foi atendida.',
    );
  });

  it('fails the run for conditions that are missing or cannot be evaluated', async () => {
    for (const [condition, message] of [
      [undefined, 'A condition node has no comparison configured.'],
      [{ operator: 'matches' as const, value: '(' }, "The condition 'matches (' is not valid."],
    ] as const) {
      const { runs, start, waitFor } = setup({
        workflow: {
          steps: [step('s1')],
          ...flow(
            [node('s1', 'step'), node('cond', 'condition', condition ? { condition } : {})],
            [edge('start', 's1'), edge('s1', 'cond')],
          ),
        },
      });
      const { run } = await start();
      await waitFor(run.id, 'failed');
      expect((await runs.get(workspaceId, run.id)).error).toBe(message);
    }
  });

  it('ends the flow at an edge into nothing and finishes without any step result', async () => {
    const { runs, issues, start, waitFor } = setup({
      workflow: {
        steps: [],
        finalReview: false,
        ...flow([delay0()], [edge('start', 'wait'), edge('wait', 'nowhere')]),
      },
    });
    const { run, issue } = await start();
    await waitFor(run.id, 'succeeded');
    expect(await runs.get(workspaceId, run.id)).toMatchObject({
      provider: 'unknown',
      inputTokens: null,
      model: null,
    });
    expect((await issues.get(workspaceId, issue.id))?.status).toBe('done');
  });

  it('fails flows wired into a cycle', async () => {
    const loopOfConditions = setup({
      workflow: {
        steps: [],
        ...flow(
          [node('cond', 'condition', { condition: { operator: 'contains', value: '' } })],
          [edge('start', 'cond'), edge('cond', 'cond', 'true')],
        ),
      },
    });
    const first = await loopOfConditions.start();
    await loopOfConditions.waitFor(first.run.id, 'failed');
    expect((await loopOfConditions.runs.get(workspaceId, first.run.id)).error).toContain(
      'visited too many nodes',
    );

    const loopOfSteps = setup({
      workflow: {
        steps: [step('s1')],
        ...flow(
          [node('s1', 'step'), delay0()],
          [edge('start', 's1'), edge('s1', 'wait'), edge('wait', 's1')],
        ),
      },
    });
    const second = await loopOfSteps.start();
    await loopOfSteps.waitFor(second.run.id, 'failed');
    expect((await loopOfSteps.runs.get(workspaceId, second.run.id)).error).toContain(
      'visited too many nodes',
    );
  });

  it('waits out a delay, and gives the wait up when the run is cancelled', async () => {
    const short = setup({
      workflow: {
        steps: [step('s1')],
        finalReview: false,
        ...flow(
          [node('wait', 'delay', { delay: { minutes: 0.00005 } }), node('s1', 'step')],
          [edge('start', 'wait'), edge('wait', 's1')],
        ),
      },
    });
    const done = await short.start();
    await short.waitFor(done.run.id, 'succeeded');
    expect((await short.runs.get(workspaceId, done.run.id)).output).toContain(
      'Aguardando 0.00005 min',
    );

    const long = setup({
      workflow: {
        steps: [step('s1')],
        finalReview: false,
        ...flow(
          [node('wait', 'delay', { delay: { minutes: 30 } }), node('s1', 'step')],
          [edge('start', 'wait'), edge('wait', 's1')],
        ),
      },
    });
    const pending = await long.start();
    await vi.waitFor(async () =>
      expect((await long.runs.get(workspaceId, pending.run.id)).output).toContain('Espera'),
    );
    await long.runs.cancel(workspaceId, pending.run.id);
    await long.waitFor(pending.run.id, 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(long.agents.executeWorkflowStep).not.toHaveBeenCalled();
  });

  it('stops walking when the run is cancelled while the flow records an event', async () => {
    const { runs, store, start, waitFor, agents } = setup({
      workflow: {
        steps: [step('s1')],
        ...flow(
          [
            node('cond', 'condition', { condition: { operator: 'contains', value: '' } }),
            node('s1', 'step'),
          ],
          [edge('start', 'cond'), edge('cond', 's1', 'true')],
        ),
      },
    });
    const progress = store.progress.bind(store);
    vi.spyOn(store, 'progress').mockImplementationOnce(async (...args) => {
      await runs.cancel(workspaceId, args[1]);
      return progress(...args);
    });
    const { run } = await start();
    await waitFor(run.id, 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(agents.executeWorkflowStep).not.toHaveBeenCalled();
  });

  it('stops looping when the run is cancelled between two steps', async () => {
    const { runs, store, start, waitFor, agents } = setup({
      workflow: {
        steps: [step('s1')],
        ...flow(
          [node('s1', 'step'), delay0()],
          [edge('start', 's1'), edge('s1', 'wait'), edge('wait', 's1')],
        ),
      },
    });
    vi.spyOn(store, 'progress').mockImplementationOnce(async (_ws, runId) => {
      await runs.cancel(workspaceId, runId);
      return null;
    });
    const { run } = await start();
    await waitFor(run.id, 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(agents.executeWorkflowStep).toHaveBeenCalledOnce();
  });

  it('lets one pause satisfy an approval wired right after a supervised step', async () => {
    const { runs, start, waitFor, state, agents } = setup({
      workflow: {
        steps: [step('s1'), step('s2')],
        autonomy: 'supervised',
        finalReview: false,
        ...flow(
          [node('s1', 'step'), node('gate', 'approval'), delay0(), node('s2', 'step')],
          [edge('start', 's1'), edge('s1', 'gate'), edge('gate', 'wait'), edge('wait', 's2')],
        ),
      },
    });
    const { run } = await start();
    await waitFor(run.id, 'waiting_review');
    expect((await state(run.id)).currentNodeId).toBe('wait');
    await runs.continueWorkflow(workspaceId, run.id, { action: 'approve' });
    await vi.waitFor(async () => expect((await state(run.id)).results.length).toBe(3));
    await waitFor(run.id, 'waiting_review');
    expect(agents.executeWorkflowStep).toHaveBeenCalledTimes(2);
    expect((await state(run.id)).currentNodeId).toBeUndefined();
    const finished = await runs.continueWorkflow(workspaceId, run.id, { action: 'approve' });
    expect(finished.status).toBe('succeeded');
  });

  it('stops at an approval node of an unsupervised flow', async () => {
    const { runs, start, waitFor, state } = setup({
      workflow: {
        steps: [step('s1')],
        finalReview: false,
        ...flow(
          [node('s1', 'step'), node('gate', 'approval'), delay0()],
          [edge('start', 's1'), edge('s1', 'gate'), edge('gate', 'wait')],
        ),
      },
    });
    const { run } = await start();
    await waitFor(run.id, 'waiting_review');
    expect((await state(run.id)).currentNodeId).toBe('wait');
    await runs.continueWorkflow(workspaceId, run.id, { action: 'approve' });
    await waitFor(run.id, 'succeeded');
  });

  it('answers a question and revises a step on a flow, resuming at the right node', async () => {
    const { runs, start, waitFor, state } = setup({
      workflow: {
        steps: [step('s1'), step('s2')],
        autonomy: 'supervised',
        finalReview: false,
        ...flow(
          [node('s1', 'step'), delay0(), node('s2', 'step')],
          [edge('start', 's1'), edge('s1', 'wait'), edge('wait', 's2')],
        ),
      },
      outcomes: [`${AGENT_WORKFLOW_QUESTION_MARKER} Which one?`, 'S1', 'S1 revised'],
    });
    const { run } = await start();
    await waitFor(run.id, 'waiting_input');
    await runs.continueWorkflow(workspaceId, run.id, { action: 'answer', answer: 'This one' });
    await waitFor(run.id, 'waiting_review');
    expect((await state(run.id)).results.map((result) => result.stepId)).toEqual([
      's1',
      's1',
      's1',
    ]);
    await runs.continueWorkflow(workspaceId, run.id, { action: 'revise', answer: 'Tighter' });
    await vi.waitFor(async () =>
      expect((await state(run.id)).results.some((result) => result.output === 'S1 revised')).toBe(
        true,
      ),
    );
    const results = (await state(run.id)).results;
    expect(results.find((result) => result.name === 'Pedido de revisão')).toMatchObject({
      stepId: 's1',
      kind: 'answer',
    });
  });

  it('revises a flow whose results hold no agent step by its workflow marker', async () => {
    const { runs, start, waitFor, state } = setup({
      workflow: {
        steps: [],
        finalReview: true,
        ...flow([delay0()], [edge('start', 'wait')]),
      },
    });
    const { run } = await start();
    await waitFor(run.id, 'waiting_review');
    await runs.continueWorkflow(workspaceId, run.id, { action: 'revise', answer: 'Again' });
    await waitFor(run.id, 'waiting_review');
    expect((await state(run.id)).results.find((result) => result.kind === 'answer')).toMatchObject({
      stepId: 'workflow',
    });
  });
});

describe('RunService flow actions', () => {
  const actionFlow = (action: AgentWorkflowCanvasNode['action'] | undefined) => ({
    steps: [],
    finalReview: false,
    canvas: {
      nodes: [trigger, node('act', 'action', action ? { action } : {})],
      edges: [edge('start', 'act')],
    },
  });

  it('fails an action node without an action and an action the server cannot perform', async () => {
    const missing = setup({ workflow: actionFlow(undefined) });
    const first = await missing.start();
    await missing.waitFor(first.run.id, 'failed');
    expect((await missing.runs.get(workspaceId, first.run.id)).error).toBe(
      'An action node has no module action configured.',
    );
    const unsupported = setup({ workflow: actionFlow({ toolset: 'pbi', toolName: 'pbi_create' }) });
    const second = await unsupported.start();
    await unsupported.waitFor(second.run.id, 'failed');
    expect((await unsupported.runs.get(workspaceId, second.run.id)).error).toContain(
      "cannot call 'pbi_create'",
    );
    const noName = setup({ workflow: actionFlow({ toolset: 'pbi' }) });
    const third = await noName.start();
    await noName.waitFor(third.run.id, 'failed');
  });

  it('comments on the issue, with a notice when the previous step produced nothing', async () => {
    const { runs, issues, start, waitFor } = setup({
      workflow: actionFlow({ toolset: 'issues', toolName: 'issues_comment' }),
    });
    const { run, issue } = await start();
    await waitFor(run.id, 'succeeded');
    expect((await issues.comments(issue.id)).at(-1)).toMatchObject({
      authorId: agentId,
      body: 'A etapa anterior não produziu resultado.',
    });
    expect((await runs.get(workspaceId, run.id)).output).toContain(
      'Comentário publicado na issue.',
    );
  });

  it('comments with the previous result', async () => {
    const { issues, start, waitFor } = setup({
      workflow: {
        steps: [step('s1')],
        finalReview: false,
        canvas: {
          nodes: [
            trigger,
            node('s1', 'step'),
            node('act', 'action', { action: { toolset: 'issues', toolName: 'issues_comment' } }),
          ],
          edges: [edge('start', 's1'), edge('s1', 'act')],
        },
      },
      outcomes: ['  The result  '],
    });
    const { run, issue } = await start();
    await waitFor(run.id, 'succeeded');
    expect((await issues.comments(issue.id)).at(-1)?.body).toBe('The result');
  });

  const notification = (extra: Record<string, unknown> = {}) => ({
    channels: ['email'],
    userIds: ['user-b'],
    roles: [] as ('assignee' | 'proofreader')[],
    subject: '',
    message: '',
    ...extra,
  });
  const notifyFlow = (config: unknown, withStep = false) => ({
    steps: withStep ? [step('s1')] : [],
    finalReview: false,
    canvas: {
      nodes: [
        trigger,
        ...(withStep ? [node('s1', 'step')] : []),
        node('act', 'action', {
          action: {
            toolset: 'notifications',
            toolName: 'notifications_send',
            ...(config ? { notification: config } : {}),
          } as never,
        }),
      ],
      edges: withStep ? [edge('start', 's1'), edge('s1', 'act')] : [edge('start', 'act')],
    },
  });

  it('notifies people about the issue, filling blank texts from the previous result', async () => {
    const sendForIssue = vi
      .fn()
      .mockResolvedValueOnce([
        { status: 'sent', reason: 'a' },
        { status: 'queued', reason: 'a' },
        { status: 'failed' },
      ])
      .mockResolvedValueOnce([{ status: 'skipped' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ status: 'sent' }]);
    const { runs, start, waitFor } = setup({
      workflow: notifyFlow(notification(), true),
      outcomes: ['Result with {{braces}}'],
      notifications: { sendForIssue },
    });
    const { run } = await start();
    await waitFor(run.id, 'succeeded');
    expect(sendForIssue.mock.calls[0]?.[0]).toMatchObject({
      subject: 'Issue #{{issue.number}}: {{issue.title}}',
      message: 'Result with { {braces}}',
      userIds: ['user-b'],
    });
    expect((await runs.get(workspaceId, run.id)).output).toContain(
      'Notified: 1 sent, 1 queued, 1 failed, 0 skipped (a).',
    );

    const second = setup({
      workflow: notifyFlow(notification({ subject: 'S', message: 'M' })),
      notifications: { sendForIssue },
    });
    const secondRun = await second.start();
    await second.waitFor(secondRun.run.id, 'succeeded');
    expect(sendForIssue.mock.calls[1]?.[0]).toMatchObject({ subject: 'S', message: 'M' });
    expect((await second.runs.get(workspaceId, secondRun.run.id)).output).toContain(
      'Notified: 0 sent, 0 queued, 0 failed, 1 skipped.',
    );

    const third = setup({
      workflow: notifyFlow(notification()),
      notifications: { sendForIssue },
    });
    const thirdRun = await third.start();
    await third.waitFor(thirdRun.run.id, 'succeeded');
    expect(sendForIssue.mock.calls[2]?.[0]).toMatchObject({
      message: 'Issue #{{issue.number}}: {{issue.title}}',
    });
    expect((await third.runs.get(workspaceId, thirdRun.run.id)).output).toContain(
      'No one to notify.',
    );
  });

  it('fails notification nodes that cannot send', async () => {
    const cases: [unknown, boolean, string][] = [
      [notification(), false, 'Notifications are not available on this server.'],
      [undefined, true, 'A notification node needs at least one channel.'],
      [notification({ channels: [] }), true, 'A notification node needs at least one channel.'],
      [
        notification({ userIds: [], roles: [] }),
        true,
        'A notification node needs people or roles to notify.',
      ],
    ];
    for (const [config, hasService, message] of cases) {
      const { runs, start, waitFor } = setup({
        workflow: notifyFlow(config),
        ...(hasService ? { notifications: { sendForIssue: vi.fn() } } : {}),
      });
      const { run } = await start();
      await waitFor(run.id, 'failed');
      expect((await runs.get(workspaceId, run.id)).error).toBe(message);
    }
  });

  it('fails a notification node whose issue disappeared, and accepts role-only recipients', async () => {
    const sendForIssue = vi.fn().mockResolvedValue([{ status: 'sent' }]);
    const gone = setup({
      workflow: notifyFlow(notification()),
      notifications: { sendForIssue },
    });
    const get = gone.issues.get.bind(gone.issues);
    let vanished = false;
    const startRun = gone.store.start.bind(gone.store);
    vi.spyOn(gone.store, 'start').mockImplementation(async (...args) => {
      vanished = true;
      return startRun(...args);
    });
    vi.spyOn(gone.issues, 'get').mockImplementation(async (...args) =>
      vanished ? null : get(...args),
    );
    const goneRun = await gone.start();
    await gone.waitFor(goneRun.run.id, 'failed');
    expect((await gone.runs.get(workspaceId, goneRun.run.id)).error).toBe(
      'The issue of this run no longer exists.',
    );

    const roles = setup({
      workflow: notifyFlow(notification({ userIds: [], roles: ['assignee'] })),
      notifications: { sendForIssue },
    });
    const rolesRun = await roles.start();
    await roles.waitFor(rolesRun.run.id, 'succeeded');
  });
});

describe('RunService usage pricing', () => {
  it('prices MCP usage with the most expensive rate of the client model provider', async () => {
    const { runs } = setup();
    const rate = (provider: string, model: string, input: number, output: number) =>
      runs.setRate({
        workspaceId,
        provider,
        model,
        inputUsdPerMillion: input,
        outputUsdPerMillion: output,
      });
    await rate('anthropic', 'small', 1, 10);
    await rate('anthropic', 'large', 5, 10);
    await rate('anthropic', 'cheap', 100, 2);
    await rate('mcp', 'exact', 2, 2);
    const usage = (model: string) =>
      runs.recordUsage(workspaceId, 'user-a', {
        tool: 'tool',
        provider: 'mcp',
        model,
        inputTokens: 1_000_000,
        outputTokens: 0,
        estimated: false,
      });
    expect((await usage('claude-code')).costMicros).toBe(5_000_000);
    expect((await usage('exact')).costMicros).toBe(2_000_000);
    expect((await usage('some-unknown-client')).costMicros).toBeNull();
    expect((await usage('gemini-cli')).costMicros).toBeNull();
  });
});

describe('RunService prompts with attachments', () => {
  const pbi = (items: Record<string, unknown>[], root: Record<string, unknown>): PbiStore =>
    ({
      get: vi.fn(async () => root),
      list: vi.fn().mockResolvedValue(items),
    }) as unknown as PbiStore;
  const image = (id: string, scope: 'issue' | 'pbi' = 'issue') => ({
    id,
    name: `${id}.png`,
    kind: 'image' as const,
    scope,
    source: 'adk' as const,
    url: `/attachments/files/${id}`,
  });

  it('lists the images of the issue, its PBI and every PBI child in the prompt', async () => {
    const pbiItems = pbi(
      [
        {
          id: 'child',
          parentId: 'root',
          title: 'Child',
          description: '![inline](https://example.com/child.png)',
          attachments: [image('child-file', 'pbi')],
        },
        { id: 'child', parentId: 'root', title: 'Child', description: 'duplicate' },
        { id: 'plain', parentId: 'other', title: 'Plain', description: 'x' },
      ],
      {
        id: 'root',
        title: 'Epic',
        description: '<img src="https://example.com/root.png" alt="root image">',
        attachments: [image('root-file', 'pbi')],
      },
    );
    const { createIssue, runs } = setup({ pbiItems });
    const issue = await createIssue('With images', {
      pbiItemId: 'root',
      attachments: [image('issue-file')],
      description: '![desc](https://example.com/issue.png)',
    });
    const run = await runs.create(issue.id, context, 'host');
    expect(run.prompt).toContain('Attached images for visual context:');
    for (const name of [
      'issue-file.png',
      'desc',
      'root-file.png',
      'root image',
      'child-file.png',
      'inline',
    ])
      expect(run.prompt).toContain(`- ${name}`);
  });

  it('copes with issues and PBI items that carry no attachment lists', async () => {
    const pbiItems = pbi([{ id: 'kid', parentId: 'root', title: 'Kid', description: 'No files' }], {
      id: 'root',
      title: 'Epic',
      description: 'No files',
    });
    const { createIssue, runs, issues } = setup({ pbiItems });
    const issue = await createIssue('Bare', { pbiItemId: 'root' });
    const stored = (await issues.get(workspaceId, issue.id))!;
    vi.spyOn(issues, 'get').mockResolvedValue({ ...stored, attachments: undefined });
    const run = await runs.create(issue.id, context, 'host');
    expect(run.prompt).not.toContain('Attached images');
  });

  it('sends the loaded images to the agent when a server run starts', async () => {
    const images = [{ mimeType: 'image/png', data: 'AAAA', name: 'a.png' }];
    vi.mocked(loadImageAttachments).mockResolvedValue(images as never);
    const imageStore = {} as E2eArtifactStore;
    const pbiItems = pbi(
      [
        {
          id: 'c1',
          parentId: 'root',
          title: 'C1',
          description: 'x',
          attachments: [image('c1', 'pbi')],
        },
        {
          id: 'c1',
          parentId: 'root',
          title: 'C1',
          description: '![i](https://example.com/c1.png)',
        },
        { id: 'c2', parentId: 'c1', title: 'C2', description: 'x' },
      ],
      {
        id: 'root',
        title: 'Epic',
        description: '![r](https://example.com/r.png)',
        attachments: [image('rf', 'pbi')],
      },
    );
    const { createIssue, runs, agents, waitFor } = setup({
      imageStore,
      pbiItems,
      workflow: { steps: [step('a')], finalReview: false },
    });
    const issue = await createIssue('Images', {
      pbiItemId: 'root',
      attachments: [image('issue-file')],
    });
    const run = await runs.create(issue.id, context);
    await waitFor(run.id, 'succeeded');
    const input = agents.executeWorkflowStep.mock.calls[0]?.[5] as { images?: unknown };
    expect(input.images).toEqual(images);
    const loaded = vi.mocked(loadImageAttachments).mock.calls[0]?.[2] as unknown as {
      id: string;
    }[];
    expect(loaded.map((attachment) => attachment.id)).toEqual(
      expect.arrayContaining(['issue-file', 'rf', 'c1']),
    );
  });

  it('sends no images when the issue vanished or links to a missing PBI item', async () => {
    const pbiItems = { get: vi.fn(async () => null), list: vi.fn() } as unknown as PbiStore;
    const { createIssue, runs, issues, store, agents, waitFor } = setup({
      imageStore: {} as E2eArtifactStore,
      pbiItems,
      workflow: { steps: [step('a')], finalReview: false },
    });
    const linked = await createIssue('Linked', { pbiItemId: 'gone' });
    const run = await runs.create(linked.id, context);
    await waitFor(run.id, 'succeeded');
    expect(agents.executeWorkflowStep.mock.calls[0]?.[5]).not.toHaveProperty('images');

    const vanishing = await createIssue('Vanishing');
    const get = issues.get.bind(issues);
    let vanished = false;
    const startRun = store.start.bind(store);
    vi.spyOn(store, 'start').mockImplementation(async (...args) => {
      vanished = true;
      return startRun(...args);
    });
    vi.spyOn(issues, 'get').mockImplementation(async (...args) => (vanished ? null : get(...args)));
    const second = await runs.create(vanishing.id, context);
    await waitFor(second.id, 'succeeded');
    expect(agents.executeWorkflowStep.mock.calls[1]?.[5]).not.toHaveProperty('images');
  });
});

describe('RunService runs without a workflow state', () => {
  const base = {
    workspaceId,
    agentId,
    actorId: 'u',
    ownerId: 'o',
    prompt: 'Plain prompt',
    attempt: 1,
    mode: 'server' as const,
  };

  it('executes the agent directly, with images, and records the result', async () => {
    const images = [{ mimeType: 'image/png', data: 'AAAA', name: 'a.png' }];
    vi.mocked(loadImageAttachments).mockResolvedValue(images as never);
    const { runs, store, issues, agents, createIssue, waitFor } = setup({
      imageStore: {} as E2eArtifactStore,
    });
    agents.executeAgent.mockResolvedValue({
      result: 'Direct result',
      provider: 'OpenAI',
      model: 'm',
      usage: { inputTokens: 3, outputTokens: 4 },
    });
    const issue = await createIssue();
    const run = (await store.claim({ ...base, issueId: issue.id }))!;
    await runs.recover();
    await waitFor(run.id, 'succeeded');
    expect(agents.executeAgent.mock.calls[0]?.[2]).toMatchObject({ images });
    expect(await runs.get(workspaceId, run.id)).toMatchObject({
      output: 'Direct result',
      inputTokens: 3,
      outputTokens: 4,
    });
    expect((await issues.get(workspaceId, issue.id))?.status).toBe('in_review');
  });

  it('publishes the answer of a comment request as a comment', async () => {
    const { runs, store, issues, agents, createIssue, waitFor } = setup();
    agents.executeAgent.mockResolvedValue({ result: 'The answer', provider: 'OpenAI' });
    const issue = await createIssue();
    const run = (await store.claim({
      ...base,
      issueId: issue.id,
      prompt: 'The latest user comment [c1] is a new request. Consider the issue and more.',
    }))!;
    await runs.recover();
    await waitFor(run.id, 'succeeded');
    expect((await issues.comments(issue.id)).at(-1)).toMatchObject({
      authorId: agentId,
      body: 'The answer',
    });
  });

  it('drops the result of a run cancelled while the agent worked', async () => {
    const { runs, store, issues, agents, createIssue, waitFor } = setup();
    let finish!: (value: unknown) => void;
    agents.executeAgent.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const issue = await createIssue();
    const run = (await store.claim({ ...base, issueId: issue.id }))!;
    await runs.recover();
    await vi.waitFor(() => expect(agents.executeAgent).toHaveBeenCalledOnce());
    await runs.cancel(workspaceId, run.id);
    finish({ result: 'late', provider: 'OpenAI' });
    await waitFor(run.id, 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await issues.get(workspaceId, issue.id))?.status).toBe('todo');
  });
});

describe('RunService records without optional lists', () => {
  it('loads images for an issue and PBI item that carry no attachment lists', async () => {
    const pbiItems = {
      get: vi.fn(async () => ({ id: 'root', title: 'Epic', description: 'Plain' })),
      list: vi.fn().mockResolvedValue([]),
    } as unknown as PbiStore;
    const { createIssue, runs, issues, agents, waitFor } = setup({
      imageStore: {} as E2eArtifactStore,
      pbiItems,
      workflow: { steps: [step('a')], finalReview: false },
    });
    const issue = await createIssue('Bare', { pbiItemId: 'root' });
    const stored = (await issues.get(workspaceId, issue.id))!;
    vi.spyOn(issues, 'get').mockResolvedValue({ ...stored, attachments: undefined });
    const run = await runs.create(issue.id, context);
    await waitFor(run.id, 'succeeded');
    expect(loadImageAttachments).toHaveBeenCalledWith(expect.anything(), workspaceId, []);
    expect(agents.executeWorkflowStep.mock.calls[0]?.[5]).not.toHaveProperty('images');
  });
});

describe('RunService restored workflow states', () => {
  const claimWaiting = async (ctx: ReturnType<typeof setup>, workflowState: WorkflowRunState) => {
    const issue = await ctx.createIssue();
    const claimed = (await ctx.store.claim({
      workspaceId,
      issueId: issue.id,
      agentId,
      actorId: 'user-a',
      ownerId: 'owner-a',
      mode: 'server',
      prompt: 'Prompt',
      attempt: 1,
      workflowState,
    }))!;
    await ctx.store.start(workspaceId, claimed.id);
    await ctx.store.checkpoint(workspaceId, claimed.id, 'waiting_review', workflowState, '');
    return claimed;
  };
  const baseState: WorkflowRunState = {
    enabled: true,
    autonomy: 'balanced',
    finalReview: false,
    uncertaintyBehavior: 'ask',
    issueCreationBehavior: 'ask',
    steps: [step('a'), step('b')],
    currentStepIndex: 1,
    results: [],
    totalCostMicros: 0,
    allStepsPriced: true,
  };

  it('counts tokens of earlier results that stored only part of their usage', async () => {
    const ctx = setup({ outcomes: [{ result: 'B', usage: { inputTokens: 2, outputTokens: 3 } }] });
    const claimed = await claimWaiting(ctx, {
      ...baseState,
      results: [
        {
          stepId: 'a',
          name: 'Step a',
          agentId,
          output: 'A',
          provider: 'OpenAI',
          kind: 'result',
          inputTokens: 5,
        },
      ],
    });
    await ctx.runs.continueWorkflow(workspaceId, claimed.id, { action: 'approve' });
    await ctx.waitFor(claimed.id, 'succeeded');
    expect(await ctx.runs.get(workspaceId, claimed.id)).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
    });
  });

  it('marks the answer of a workflow without steps with the workflow marker', async () => {
    const ctx = setup();
    const claimed = await claimWaiting(ctx, { ...baseState, steps: [], currentStepIndex: 0 });
    await ctx.runs.continueWorkflow(workspaceId, claimed.id, {
      action: 'revise',
      answer: 'Again',
    });
    await vi.waitFor(async () =>
      expect(
        (await ctx.state(claimed.id)).results.find((result) => result.kind === 'answer'),
      ).toMatchObject({ stepId: 'workflow' }),
    );
  });
});

describe('RunService host step reports', () => {
  it('fails when the run was finished while the report was stored', async () => {
    const { runs, store, createIssue } = setup({
      workflow: { steps: [step('a')], finalReview: false },
    });
    const issue = await createIssue();
    const run = await runs.create(issue.id, context, 'host');
    await runs.checkout(workspaceId, run.id);
    vi.spyOn(store, 'progress').mockResolvedValueOnce(null);
    await expect(
      runs.reportStep(workspaceId, run.id, { nodeId: 'a', status: 'started' }),
    ).rejects.toMatchObject({ code: 'INVALID_RUN_STATE' });
  });
});
