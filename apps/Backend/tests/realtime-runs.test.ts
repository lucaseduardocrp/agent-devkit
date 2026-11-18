import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { createIssuesRouter } from '../src/adapters/http/issues-routes.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';
import {
  EMPTY_AGENT_WORKFLOW,
  type AgentWorkflowCanvas,
} from '../src/modules/agents/domain/agent-workflow.js';
import { EventingRunStore, runEventPayload } from '../src/modules/issues/eventing-run-store.js';
import { InMemoryIssueStore } from '../src/modules/issues/issue-store.js';
import { InMemoryRunStore } from '../src/modules/issues/run-store.js';
import { RunService } from '../src/modules/issues/run-service.js';
import { InMemoryEventBus, type RealtimeEvent } from '../src/modules/realtime/event-bus.js';

const workspaceId = 'workspace-a';
const context = { requestId: 'test', workspaceId, ownerId: 'owner-a', actorId: 'user-a' };
const agentId = 'agent-a';

describe('InMemoryEventBus', () => {
  it('delivers an event to the subscribers of its workspace only', () => {
    const bus = new InMemoryEventBus();
    const mine = vi.fn();
    const other = vi.fn();
    bus.subscribe('ws-1', mine);
    bus.subscribe('ws-2', other);
    bus.publish('ws-1', 'run', { id: 'r1' });
    expect(mine).toHaveBeenCalledOnce();
    expect(mine.mock.calls[0]![0]).toMatchObject({
      type: 'run',
      workspaceId: 'ws-1',
      data: { id: 'r1' },
    });
    expect(Date.parse((mine.mock.calls[0]![0] as RealtimeEvent).at)).not.toBeNaN();
    expect(other).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe and forgets empty workspaces', () => {
    const bus = new InMemoryEventBus();
    const listener = vi.fn();
    const stop = bus.subscribe('ws-1', listener);
    expect(bus.subscriberCount('ws-1')).toBe(1);
    stop();
    expect(bus.subscriberCount('ws-1')).toBe(0);
    bus.publish('ws-1', 'run', {});
    expect(listener).not.toHaveBeenCalled();
    expect(bus.subscriberCount('unknown')).toBe(0);
  });

  it('keeps delivering when one subscriber fails', () => {
    const bus = new InMemoryEventBus();
    const failing = vi.fn(() => {
      throw new Error('socket closed');
    });
    const healthy = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    bus.subscribe('ws-1', failing);
    bus.subscribe('ws-1', healthy);
    expect(() => bus.publish('ws-1', 'run', {})).not.toThrow();
    expect(healthy).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});

describe('EventingRunStore', () => {
  const claimInput = {
    workspaceId,
    issueId: 'issue-1',
    agentId,
    actorId: 'user-a',
    ownerId: 'owner-a',
    mode: 'host' as const,
    prompt: 'A long prompt',
    attempt: 1,
  };

  it('announces every change of a run without its prompt and output', async () => {
    const bus = new InMemoryEventBus();
    const events: Record<string, unknown>[] = [];
    bus.subscribe(workspaceId, (event) => events.push(event.data as Record<string, unknown>));
    const store = new EventingRunStore(new InMemoryRunStore(), bus);

    const run = (await store.claim(claimInput))!;
    await store.start(workspaceId, run.id);
    const state = { ...run.workflowState!, currentStepIndex: 1 };
    await store.progress(workspaceId, run.id, state, 'partial', {});
    await store.checkpoint(workspaceId, run.id, 'waiting_review', state, 'review');
    await store.resume(workspaceId, run.id, state, 'resumed');
    await store.finish(workspaceId, run.id, 'succeeded', { output: 'done' });

    expect(events.map((event) => event['status'])).toEqual([
      'queued',
      'running',
      'running',
      'waiting_review',
      'queued',
      'succeeded',
    ]);
    for (const event of events) {
      expect(event).toMatchObject({ id: run.id, issueId: 'issue-1', agentId });
      expect(event).not.toHaveProperty('prompt');
      expect(event).not.toHaveProperty('output');
    }
  });

  it('stays silent when nothing changed and passes everything else through', async () => {
    const bus = new InMemoryEventBus();
    const listener = vi.fn();
    bus.subscribe(workspaceId, listener);
    const store = new EventingRunStore(new InMemoryRunStore(), bus);
    expect(store.managesIssueStatus).toBe(false);
    expect(await store.start(workspaceId, 'missing')).toBeNull();
    expect(listener).not.toHaveBeenCalled();

    const run = (await store.claim({ ...claimInput, assigneeUserId: 'user-b' }))!;
    expect(await store.get(workspaceId, run.id)).toMatchObject({ id: run.id });
    expect(await store.list(workspaceId)).toHaveLength(1);
    expect(await store.assignedTo(workspaceId, 'user-b')).toHaveLength(1);
    expect(await store.incomplete()).toHaveLength(1);
    await store.setBudget(workspaceId, 5);
    expect(await store.getBudget(workspaceId)).toBe(5);
    const rate = {
      workspaceId,
      provider: 'openai',
      model: 'm',
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
    };
    await store.setRate(rate);
    expect(await store.rates(workspaceId)).toEqual([rate]);
    expect(await store.removeRate(workspaceId, 'openai', 'm')).toBe(true);
    expect(runEventPayload(run)).not.toHaveProperty('prompt');
  });
});

function reportingSetup(options: { canvas?: AgentWorkflowCanvas; enabled?: boolean } = {}) {
  const steps = [
    { id: 'triage', name: 'Triage', instructions: 'Triage it.', agentId: 'agent-triage' },
    { id: 'summary', name: 'Summary', instructions: 'Summarise it.' },
  ];
  const workflow = {
    ...EMPTY_AGENT_WORKFLOW,
    enabled: options.enabled ?? true,
    steps,
    ...(options.canvas ? { canvas: options.canvas } : {}),
  };
  const issues = new InMemoryIssueStore();
  const bus = new InMemoryEventBus();
  const store = new EventingRunStore(new InMemoryRunStore(), bus);
  const agents = {
    getAgent: vi.fn().mockResolvedValue({ id: agentId, name: 'Agent A' }),
    getWorkflow: vi.fn().mockResolvedValue(workflow),
  } as unknown as AgentService;
  const runs = new RunService(store, issues, agents);
  const events: Record<string, unknown>[] = [];
  bus.subscribe(workspaceId, (event) => events.push(event.data as Record<string, unknown>));
  const start = async (checkout = true) => {
    const issue = await issues.create(workspaceId, 'user-a', {
      title: 'Report me',
      assigneeAgentId: agentId,
    });
    const run = await runs.create(issue.id, context, 'host');
    if (checkout) await runs.checkout(workspaceId, run.id);
    return run;
  };
  return { runs, start, events };
}

const flowCanvas: AgentWorkflowCanvas = {
  nodes: [
    { id: 'start', kind: 'trigger', x: 0, y: 0, trigger: { kind: 'issue-assigned' } },
    { id: 'triage', kind: 'step', x: 300, y: 0 },
    {
      id: 'cond',
      kind: 'condition',
      x: 600,
      y: 0,
      condition: { operator: 'contains', value: 'COMPLEX' },
    },
    { id: 'summary', kind: 'step', x: 900, y: 0 },
  ],
  edges: [
    { id: 'e1', from: 'start', to: 'triage' },
    { id: 'e2', from: 'triage', to: 'cond' },
    { id: 'e3', from: 'cond', to: 'summary', fromPort: 'true' },
  ],
};

describe('RunService.reportStep', () => {
  it('moves a host run along its steps and tells the workspace', async () => {
    const { runs, start, events } = reportingSetup();
    const run = await start();
    events.length = 0;

    const started = await runs.reportStep(workspaceId, run.id, {
      nodeId: 'triage',
      status: 'started',
    });
    expect(started.workflowState).toMatchObject({ currentStepIndex: 0, results: [] });
    expect(started.workflowState).not.toHaveProperty('currentNodeId');

    const done = await runs.reportStep(workspaceId, run.id, {
      nodeId: 'triage',
      status: 'completed',
      summary: 'NÍVEL: COMPLEXO',
    });
    expect(done.workflowState).toMatchObject({
      currentStepIndex: 1,
      results: [
        {
          stepId: 'triage',
          name: 'Triage',
          agentId: 'agent-triage',
          output: 'NÍVEL: COMPLEXO',
          kind: 'result',
          provider: 'host',
        },
      ],
    });

    const next = await runs.reportStep(workspaceId, run.id, {
      nodeId: 'summary',
      status: 'completed',
    });
    // A step without its own agent is credited to the agent assigned to the run.
    expect(next.workflowState!.results[1]).toMatchObject({ agentId, output: '' });
    expect(next.workflowState!.currentStepIndex).toBe(2);
    expect(events.map((event) => event['status'])).toEqual(['running', 'running', 'running']);
    expect((events[1]!['workflowState'] as { results: unknown[] }).results).toHaveLength(1);
  });

  it('tracks the current node of a flow and records conditions as events', async () => {
    const { runs, start } = reportingSetup({ canvas: flowCanvas });
    const run = await start();

    const started = await runs.reportStep(workspaceId, run.id, {
      nodeId: 'triage',
      status: 'started',
    });
    expect(started.workflowState).toMatchObject({ currentNodeId: 'triage', currentStepIndex: 0 });

    // Reporting a node again replaces its earlier result instead of piling up.
    await runs.reportStep(workspaceId, run.id, {
      nodeId: 'triage',
      status: 'completed',
      summary: 'first',
    });
    const retried = await runs.reportStep(workspaceId, run.id, {
      nodeId: 'triage',
      status: 'completed',
      summary: 'second',
    });
    expect(retried.workflowState!.results).toHaveLength(1);
    expect(retried.workflowState!.results[0]!.output).toBe('second');
    expect(retried.workflowState).not.toHaveProperty('currentNodeId');

    await runs.reportStep(workspaceId, run.id, { nodeId: 'cond', status: 'started' });
    const condition = await runs.reportStep(workspaceId, run.id, {
      nodeId: 'cond',
      status: 'completed',
      summary: 'true',
    });
    expect(condition.workflowState!.results.at(-1)).toMatchObject({
      stepId: 'cond',
      kind: 'event',
      name: 'cond',
      agentId,
    });
    // Completing a node that is not the current one leaves the current node alone.
    await runs.reportStep(workspaceId, run.id, { nodeId: 'summary', status: 'started' });
    const other = await runs.reportStep(workspaceId, run.id, {
      nodeId: 'cond',
      status: 'completed',
    });
    expect(other.workflowState).toMatchObject({ currentNodeId: 'summary' });
  });

  it('refuses reports that cannot belong to the run', async () => {
    const { runs, start } = reportingSetup();
    const queued = await start(false);
    await expect(
      runs.reportStep(workspaceId, queued.id, { nodeId: 'triage', status: 'started' }),
    ).rejects.toMatchObject({ code: 'INVALID_RUN_STATE' });

    const running = await start();
    await expect(
      runs.reportStep(workspaceId, running.id, { nodeId: 'nope', status: 'started' }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_STEP', statusCode: 400 });

    const plain = reportingSetup({ enabled: false });
    const noWorkflow = await plain.start();
    await expect(
      plain.runs.reportStep(workspaceId, noWorkflow.id, { nodeId: 'triage', status: 'started' }),
    ).rejects.toMatchObject({ code: 'NO_WORKFLOW' });
  });
});

describe('run routes', () => {
  function setup() {
    const eventBus = new InMemoryEventBus();
    const app = createApp({
      eventBus,
      requestContextResolver: (req) => ({
        requestId: 'realtime-test',
        ownerId: 'workspace-a',
        workspaceId: req.header('x-test-workspace') ?? 'workspace-a',
        actorId: 'user-a',
        memberRole: req.header('x-test-role') === 'VIEWER' ? 'VIEWER' : 'ADMIN',
      }),
    });
    return { app, eventBus };
  }

  async function hostRun(app: ReturnType<typeof setup>['app']) {
    const agent = await request(app)
      .post('/agents')
      .send({ name: 'PO', instructions: 'Own the product.' })
      .expect(201);
    await request(app)
      .put('/agents/workflow')
      .send({
        enabled: true,
        steps: [{ id: 'triage', name: 'Triage', instructions: 'Triage the issue.' }],
      })
      .expect(200);
    const created = await request(app)
      .post('/issues')
      .send({ title: 'Stream me', assigneeAgentId: agent.body.agent.id, runMode: 'host' })
      .expect(201);
    return created.body.run.id as string;
  }

  it('reports the steps of a checked-out host run', async () => {
    const { app } = setup();
    const runId = await hostRun(app);
    await request(app).post(`/runs/${runId}/checkout`).expect(200);

    const started = await request(app)
      .post(`/runs/${runId}/steps`)
      .send({ nodeId: 'triage', status: 'started' })
      .expect(200);
    expect(started.body.run.workflowState.currentStepIndex).toBe(0);
    const completed = await request(app)
      .post(`/runs/${runId}/steps`)
      .send({ nodeId: 'triage', status: 'completed', summary: 'Done' })
      .expect(200);
    expect(completed.body.run.workflowState.results[0]).toMatchObject({
      stepId: 'triage',
      output: 'Done',
    });

    await request(app)
      .post(`/runs/${runId}/steps`)
      .send({ nodeId: '', status: 'started' })
      .expect(400);
    await request(app)
      .post(`/runs/${runId}/steps`)
      .send({ nodeId: 'x', status: 'odd' })
      .expect(400);
    await request(app)
      .post(`/runs/${runId}/steps`)
      .send({ nodeId: 'ghost', status: 'started' })
      .expect(400);
    await request(app)
      .post(`/runs/${runId}/steps`)
      .set('x-test-role', 'VIEWER')
      .send({ nodeId: 'triage', status: 'started' })
      .expect(403);
  });

  it('streams the runs of the workspace as they change', async () => {
    const { app, eventBus } = setup();
    const server = app.listen(0);
    const controller = new AbortController();
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/runs/stream`, {
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(response.headers.get('cache-control')).toContain('no-transform');
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let received = '';
      const readUntil = async (text: string) => {
        while (!received.includes(text)) {
          const { done, value } = await reader.read();
          if (done) throw new Error(`Stream ended before "${text}": ${received}`);
          received += decoder.decode(value);
        }
      };

      await readUntil('event: ready');
      expect(eventBus.subscriberCount('workspace-a')).toBe(1);

      await hostRun(app);
      await readUntil('event: run');
      await readUntil('"status":"queued"');
      expect(received).not.toContain('Own the product');
      expect(received).not.toContain('"prompt"');
    } finally {
      controller.abort();
      await new Promise((resolve) => server.close(resolve));
    }
    await vi.waitFor(() => expect(eventBus.subscriberCount('workspace-a')).toBe(0));
  });

  it('sends a heartbeat so idle proxies keep the stream open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { app } = setup();
    const server = app.listen(0);
    const controller = new AbortController();
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/runs/stream`, {
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      await reader.read(); // retry + ready
      vi.advanceTimersByTime(25_000);
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toContain(': keep-alive');
    } finally {
      controller.abort();
      vi.useRealTimers();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('answers 501 when the server has no event bus', async () => {
    // createApp always wires a bus; the router alone shows what happens without one.
    const express = (await import('express')).default;
    const bare = express().use(
      createIssuesRouter(new InMemoryIssueStore(), {} as never, {} as never, {} as never, () => ({
        requestId: 't',
        ownerId: 'workspace-a',
        workspaceId: 'workspace-a',
        actorId: 'user-a',
        memberRole: 'ADMIN',
      })),
    );
    await request(bare).get('/runs/stream').expect(501);
  });
});
