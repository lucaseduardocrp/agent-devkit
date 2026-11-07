import type { EventBus } from '../realtime/event-bus.js';
import type { AgentRun, RunStore } from './run-store.js';

/** What a stream sends about a run: the run without its prompt and output, which are large. */
export type RunEventPayload = Omit<AgentRun, 'prompt' | 'output'>;

export function runEventPayload(run: AgentRun): RunEventPayload {
  const { prompt: _prompt, output: _output, ...payload } = run;
  return payload;
}

/**
 * A run store that tells the workspace whenever a run changes. Every transition of a run goes
 * through the store, so the runs of the server and of the host (MCP) are covered in one place.
 */
export class EventingRunStore implements RunStore {
  constructor(
    private readonly inner: RunStore,
    private readonly bus: EventBus,
  ) {}

  get managesIssueStatus(): boolean {
    return this.inner.managesIssueStatus;
  }

  private announce(run: AgentRun | null): AgentRun | null {
    if (run) this.bus.publish(run.workspaceId, 'run', runEventPayload(run), run.id);
    return run;
  }

  incomplete = () => this.inner.incomplete();
  list: RunStore['list'] = (workspaceId, issueId) => this.inner.list(workspaceId, issueId);
  assignedTo: RunStore['assignedTo'] = (workspaceId, userId) =>
    this.inner.assignedTo(workspaceId, userId);
  get: RunStore['get'] = (workspaceId, runId) => this.inner.get(workspaceId, runId);

  claim: RunStore['claim'] = async (input) => this.announce(await this.inner.claim(input));
  start: RunStore['start'] = async (workspaceId, runId) =>
    this.announce(await this.inner.start(workspaceId, runId));
  progress: RunStore['progress'] = async (workspaceId, runId, state, output, metrics) =>
    this.announce(await this.inner.progress(workspaceId, runId, state, output, metrics));
  checkpoint: RunStore['checkpoint'] = async (workspaceId, runId, status, state, output) =>
    this.announce(await this.inner.checkpoint(workspaceId, runId, status, state, output));
  resume: RunStore['resume'] = async (workspaceId, runId, state, output) =>
    this.announce(await this.inner.resume(workspaceId, runId, state, output));
  finish: RunStore['finish'] = async (workspaceId, runId, status, result, issueStatus) =>
    this.announce(await this.inner.finish(workspaceId, runId, status, result, issueStatus));

  getBudget: RunStore['getBudget'] = (workspaceId) => this.inner.getBudget(workspaceId);
  setBudget: RunStore['setBudget'] = (workspaceId, micros) =>
    this.inner.setBudget(workspaceId, micros);
  rates: RunStore['rates'] = (workspaceId) => this.inner.rates(workspaceId);
  setRate: RunStore['setRate'] = (rate) => this.inner.setRate(rate);
  removeRate: RunStore['removeRate'] = (workspaceId, provider, model) =>
    this.inner.removeRate(workspaceId, provider, model);
}
