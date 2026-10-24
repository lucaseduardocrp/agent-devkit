import type {
  ApiCollection,
  ApiEnvironment,
  ApiRun,
  ApiRunKind,
  ApiRunStatus,
  LoadScenario,
} from '../domain/api-test.js';

export type NewApiRun = Omit<
  ApiRun,
  | 'id'
  | 'status'
  | 'claimedBy'
  | 'claimLabel'
  | 'heartbeatAt'
  | 'attempts'
  | 'result'
  | 'error'
  | 'createdAt'
  | 'startedAt'
  | 'finishedAt'
>;

export interface RunFilter {
  readonly kind?: ApiRunKind;
  readonly collectionId?: string;
  readonly scenarioId?: string;
  readonly limit?: number;
}

export interface RunOutcome {
  readonly status: Extract<ApiRunStatus, 'passed' | 'failed' | 'error'>;
  readonly result: ApiRun['result'];
  readonly error: string | null;
}

/** Storage of collections, environments, load scenarios and runs (which double as the queue). */
export interface ApiTestStore {
  listCollections(workspaceId: string): Promise<ApiCollection[]>;
  getCollection(workspaceId: string, id: string): Promise<ApiCollection | null>;
  saveCollection(collection: ApiCollection): Promise<ApiCollection>;
  deleteCollection(workspaceId: string, id: string): Promise<boolean>;

  listEnvironments(workspaceId: string): Promise<ApiEnvironment[]>;
  getEnvironment(workspaceId: string, id: string): Promise<ApiEnvironment | null>;
  saveEnvironment(environment: ApiEnvironment): Promise<ApiEnvironment>;
  deleteEnvironment(workspaceId: string, id: string): Promise<boolean>;

  listScenarios(workspaceId: string): Promise<LoadScenario[]>;
  getScenario(workspaceId: string, id: string): Promise<LoadScenario | null>;
  saveScenario(scenario: LoadScenario): Promise<LoadScenario>;
  deleteScenario(workspaceId: string, id: string): Promise<boolean>;

  createRun(run: NewApiRun): Promise<ApiRun>;
  getRun(workspaceId: string, id: string): Promise<ApiRun | null>;
  /** Newest first, without the payload. */
  listRuns(workspaceId: string, filter?: RunFilter): Promise<ApiRun[]>;
  /** Atomically takes the oldest queued remote run (any workspace) for a worker. */
  claimRemote(workerId: string): Promise<ApiRun | null>;
  /** Atomically takes the user's oldest queued local run for their `devkit runner`. */
  claimLocal(
    scope: { readonly workspaceId: string; readonly userId: string },
    runner: { readonly id: string; readonly label: string },
  ): Promise<ApiRun | null>;
  /** Keeps a claimed run alive, optionally saving partial results; null when it is gone or not this claimer's. */
  heartbeat(id: string, claimer: string, partial?: ApiRun['result']): Promise<ApiRunStatus | null>;
  /** Records the outcome of a running run held by this claimer; false otherwise. */
  finish(id: string, claimer: string, outcome: RunOutcome): Promise<boolean>;
  /** Cancels a queued or running run; false when it already ended. */
  cancel(workspaceId: string, id: string): Promise<boolean>;
  /** Running runs whose holder stopped heartbeating go back to the queue or end in error. */
  sweep(staleBefore: Date, maxAttempts: number): Promise<{ requeued: number; failed: number }>;
  deleteRun(workspaceId: string, id: string): Promise<boolean>;
}

const ACTIVE = new Set<ApiRunStatus>(['queued', 'running']);

export class InMemoryApiTestStore implements ApiTestStore {
  private readonly collections = new Map<string, ApiCollection>();
  private readonly environments = new Map<string, ApiEnvironment>();
  private readonly scenarios = new Map<string, LoadScenario>();
  private readonly runs = new Map<string, ApiRun>();

  private static inWorkspace<T extends { workspaceId: string; updatedAt?: Date }>(
    map: Map<string, T>,
    workspaceId: string,
  ): T[] {
    return [...map.values()].filter((item) => item.workspaceId === workspaceId);
  }

  listCollections(workspaceId: string) {
    return Promise.resolve(
      InMemoryApiTestStore.inWorkspace(this.collections, workspaceId).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    );
  }
  getCollection(workspaceId: string, id: string) {
    const found = this.collections.get(id);
    return Promise.resolve(found?.workspaceId === workspaceId ? found : null);
  }
  saveCollection(collection: ApiCollection) {
    this.collections.set(collection.id, collection);
    return Promise.resolve(collection);
  }
  deleteCollection(workspaceId: string, id: string) {
    if (this.collections.get(id)?.workspaceId !== workspaceId) return Promise.resolve(false);
    this.collections.delete(id);
    for (const [key, scenario] of this.scenarios)
      if (scenario.collectionId === id) this.scenarios.delete(key);
    return Promise.resolve(true);
  }

  listEnvironments(workspaceId: string) {
    return Promise.resolve(
      InMemoryApiTestStore.inWorkspace(this.environments, workspaceId).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    );
  }
  getEnvironment(workspaceId: string, id: string) {
    const found = this.environments.get(id);
    return Promise.resolve(found?.workspaceId === workspaceId ? found : null);
  }
  saveEnvironment(environment: ApiEnvironment) {
    this.environments.set(environment.id, environment);
    return Promise.resolve(environment);
  }
  deleteEnvironment(workspaceId: string, id: string) {
    if (this.environments.get(id)?.workspaceId !== workspaceId) return Promise.resolve(false);
    this.environments.delete(id);
    return Promise.resolve(true);
  }

  listScenarios(workspaceId: string) {
    return Promise.resolve(
      InMemoryApiTestStore.inWorkspace(this.scenarios, workspaceId).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    );
  }
  getScenario(workspaceId: string, id: string) {
    const found = this.scenarios.get(id);
    return Promise.resolve(found?.workspaceId === workspaceId ? found : null);
  }
  saveScenario(scenario: LoadScenario) {
    this.scenarios.set(scenario.id, scenario);
    return Promise.resolve(scenario);
  }
  deleteScenario(workspaceId: string, id: string) {
    if (this.scenarios.get(id)?.workspaceId !== workspaceId) return Promise.resolve(false);
    this.scenarios.delete(id);
    return Promise.resolve(true);
  }

  createRun(input: NewApiRun) {
    const run: ApiRun = {
      ...input,
      id: crypto.randomUUID(),
      status: 'queued',
      claimedBy: null,
      claimLabel: null,
      heartbeatAt: null,
      attempts: 0,
      result: null,
      error: null,
      createdAt: new Date(),
      startedAt: null,
      finishedAt: null,
    };
    this.runs.set(run.id, run);
    return Promise.resolve(run);
  }
  getRun(workspaceId: string, id: string) {
    const found = this.runs.get(id);
    return Promise.resolve(found?.workspaceId === workspaceId ? found : null);
  }
  listRuns(workspaceId: string, filter: RunFilter = {}) {
    return Promise.resolve(
      [...this.runs.values()]
        .filter(
          (run) =>
            run.workspaceId === workspaceId &&
            (!filter.kind || run.kind === filter.kind) &&
            (!filter.collectionId || run.collectionId === filter.collectionId) &&
            (!filter.scenarioId || run.scenarioId === filter.scenarioId),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, filter.limit ?? 50)
        .map((run) => ({ ...run, payload: null })),
    );
  }
  private claim(match: (run: ApiRun) => boolean, claimer: string, label: string) {
    const next = [...this.runs.values()]
      .filter((run) => run.status === 'queued' && match(run))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    if (!next) return Promise.resolve(null);
    const claimed: ApiRun = {
      ...next,
      status: 'running',
      claimedBy: claimer,
      claimLabel: label,
      heartbeatAt: new Date(),
      attempts: next.attempts + 1,
      startedAt: next.startedAt ?? new Date(),
    };
    this.runs.set(claimed.id, claimed);
    return Promise.resolve(claimed);
  }
  claimRemote(workerId: string) {
    return this.claim((run) => run.target === 'remote', workerId, 'ADK worker');
  }
  claimLocal(
    scope: { workspaceId: string; userId: string },
    runner: { id: string; label: string },
  ) {
    return this.claim(
      (run) =>
        run.target === 'local' &&
        run.workspaceId === scope.workspaceId &&
        run.requestedBy === scope.userId,
      runner.id,
      runner.label,
    );
  }
  heartbeat(id: string, claimer: string, partial?: ApiRun['result']) {
    const run = this.runs.get(id);
    if (!run || run.claimedBy !== claimer) return Promise.resolve(null);
    if (run.status === 'running') {
      this.runs.set(id, {
        ...run,
        heartbeatAt: new Date(),
        ...(partial ? { result: partial } : {}),
      });
    }
    return Promise.resolve(run.status);
  }
  finish(id: string, claimer: string, outcome: RunOutcome) {
    const run = this.runs.get(id);
    if (run?.status !== 'running' || run.claimedBy !== claimer) return Promise.resolve(false);
    this.runs.set(id, { ...run, ...outcome, payload: null, finishedAt: new Date() });
    return Promise.resolve(true);
  }
  cancel(workspaceId: string, id: string) {
    const run = this.runs.get(id);
    if (run?.workspaceId !== workspaceId || !ACTIVE.has(run.status)) return Promise.resolve(false);
    this.runs.set(id, { ...run, status: 'cancelled', payload: null, finishedAt: new Date() });
    return Promise.resolve(true);
  }
  sweep(staleBefore: Date, maxAttempts: number) {
    let requeued = 0;
    let failed = 0;
    for (const run of this.runs.values()) {
      if (run.status !== 'running' || Number(run.heartbeatAt) >= staleBefore.getTime()) continue;
      if (run.attempts >= maxAttempts) {
        failed += 1;
        this.runs.set(run.id, {
          ...run,
          status: 'error',
          error: 'The run stopped responding.',
          payload: null,
          finishedAt: new Date(),
        });
      } else {
        requeued += 1;
        this.runs.set(run.id, {
          ...run,
          status: 'queued',
          claimedBy: null,
          claimLabel: null,
          heartbeatAt: null,
        });
      }
    }
    return Promise.resolve({ requeued, failed });
  }
  deleteRun(workspaceId: string, id: string) {
    const run = this.runs.get(id);
    if (run?.workspaceId !== workspaceId || ACTIVE.has(run.status)) return Promise.resolve(false);
    this.runs.delete(id);
    return Promise.resolve(true);
  }
}
