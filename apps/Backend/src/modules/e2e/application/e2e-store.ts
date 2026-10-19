import crypto from 'node:crypto';
import {
  ACTIVE_CREATION_STATUSES,
  testCaseCode,
  type E2eCreation,
  type E2ePriority,
  type E2eTestCase,
} from '../domain/e2e.js';
import type { ExternalTestCase } from '../../test-management/domain/test-run.js';

export type NewE2eCreation = Pick<
  E2eCreation,
  | 'workspaceId'
  | 'ownerId'
  | 'actorId'
  | 'agentId'
  | 'name'
  | 'mode'
  | 'scope'
  | 'baseUrl'
  | 'localOrigin'
  | 'path'
  | 'username'
  | 'passwordSecret'
  | 'accessSecret'
  | 'prd'
  | 'prdFileNames'
  | 'diff'
  | 'instructions'
  | 'locale'
  | 'repository'
> & {
  /** Defaults to remote (the ADK workers). */
  readonly executionTarget?: E2eCreation['executionTarget'];
  /** Defaults to queued; a draft waits for a plan written by the MCP host. */
  readonly status?: E2eCreation['status'];
  readonly reporting?: E2eCreation['reporting'];
};

/** Fields the user can change when editing a run's configuration. */
export type E2eCreationSettings = Pick<
  E2eCreation,
  | 'agentId'
  | 'name'
  | 'mode'
  | 'scope'
  | 'baseUrl'
  | 'localOrigin'
  | 'executionTarget'
  | 'path'
  | 'username'
  | 'passwordSecret'
  | 'accessSecret'
  | 'prd'
  | 'prdFileNames'
  | 'diff'
  | 'instructions'
  | 'repository'
>;

export type E2eCreationChanges = Partial<
  Pick<E2eCreation, 'status' | 'error' | 'prdSummary' | 'finishedAt' | 'reporting' | 'lastReport'> &
    E2eCreationSettings
>;

export interface NewE2eTestCase {
  readonly title: string;
  readonly description: string;
  readonly steps: readonly string[];
  readonly priority: E2ePriority;
  /** Set when the test is imported from a spec that already exists in the repository. */
  readonly scriptPath?: string;
  /** Set when the test automates a case imported from a test management platform. */
  readonly externalCase?: ExternalTestCase | null;
}

export type E2eTestChanges = Partial<
  Pick<
    E2eTestCase,
    | 'steps'
    | 'scriptPath'
    | 'externalCase'
    | 'stepResults'
    | 'status'
    | 'error'
    | 'analysis'
    | 'verdict'
    | 'logs'
    | 'videoKey'
    | 'durationMs'
    | 'executedOn'
    | 'attempts'
    | 'lastRunAt'
  >
>;

export interface E2eStore {
  createCreation(input: NewE2eCreation): Promise<E2eCreation>;
  getCreation(workspaceId: string, id: string): Promise<E2eCreation | null>;
  listCreations(workspaceId: string): Promise<E2eCreation[]>;
  updateCreation(
    workspaceId: string,
    id: string,
    changes: E2eCreationChanges,
  ): Promise<E2eCreation | null>;
  deleteCreation(workspaceId: string, id: string): Promise<boolean>;
  incompleteCreations(): Promise<E2eCreation[]>;
  replaceTests(creation: E2eCreation, cases: readonly NewE2eTestCase[]): Promise<E2eTestCase[]>;
  /** Adds tests after the existing ones, continuing the TC numbering. */
  appendTests(creation: E2eCreation, cases: readonly NewE2eTestCase[]): Promise<E2eTestCase[]>;
  listTests(workspaceId: string, creationId?: string): Promise<E2eTestCase[]>;
  getTest(workspaceId: string, id: string): Promise<E2eTestCase | null>;
  updateTest(workspaceId: string, id: string, changes: E2eTestChanges): Promise<E2eTestCase | null>;
}

export function buildTestCases(
  creation: Pick<E2eCreation, 'id' | 'workspaceId'>,
  cases: readonly NewE2eTestCase[],
  firstPosition = 1,
): E2eTestCase[] {
  const now = new Date();
  return cases.map((item, index) => ({
    id: crypto.randomUUID(),
    creationId: creation.id,
    workspaceId: creation.workspaceId,
    position: firstPosition + index,
    code: testCaseCode(firstPosition + index),
    title: item.title,
    description: item.description,
    steps: [...item.steps],
    priority: item.priority,
    scriptPath: item.scriptPath ?? null,
    externalCase: item.externalCase ?? null,
    stepResults: [],
    status: 'pending',
    error: null,
    analysis: null,
    verdict: null,
    logs: null,
    videoKey: null,
    durationMs: null,
    executedOn: null,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
  }));
}

export class InMemoryE2eStore implements E2eStore {
  private readonly creations = new Map<string, E2eCreation>();
  private readonly tests = new Map<string, E2eTestCase>();

  createCreation(input: NewE2eCreation): Promise<E2eCreation> {
    const now = new Date();
    const creation: E2eCreation = {
      ...input,
      executionTarget: input.executionTarget ?? 'remote',
      prdFileNames: [...input.prdFileNames],
      reporting: input.reporting ?? null,
      lastReport: null,
      id: crypto.randomUUID(),
      prdSummary: null,
      status: input.status ?? 'queued',
      error: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    this.creations.set(creation.id, creation);
    return Promise.resolve(creation);
  }

  getCreation(workspaceId: string, id: string): Promise<E2eCreation | null> {
    const creation = this.creations.get(id);
    return Promise.resolve(creation?.workspaceId === workspaceId ? creation : null);
  }

  listCreations(workspaceId: string): Promise<E2eCreation[]> {
    return Promise.resolve(
      [...this.creations.values()]
        .filter((creation) => creation.workspaceId === workspaceId)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
    );
  }

  async updateCreation(
    workspaceId: string,
    id: string,
    changes: E2eCreationChanges,
  ): Promise<E2eCreation | null> {
    const creation = await this.getCreation(workspaceId, id);
    if (!creation) return null;
    const next = { ...creation, ...changes, updatedAt: new Date() };
    this.creations.set(id, next);
    return next;
  }

  async deleteCreation(workspaceId: string, id: string): Promise<boolean> {
    if (!(await this.getCreation(workspaceId, id))) return false;
    this.creations.delete(id);
    for (const test of [...this.tests.values()])
      if (test.creationId === id) this.tests.delete(test.id);
    return true;
  }

  incompleteCreations(): Promise<E2eCreation[]> {
    return Promise.resolve(
      [...this.creations.values()].filter((creation) =>
        ACTIVE_CREATION_STATUSES.includes(creation.status),
      ),
    );
  }

  replaceTests(creation: E2eCreation, cases: readonly NewE2eTestCase[]): Promise<E2eTestCase[]> {
    for (const test of [...this.tests.values()])
      if (test.creationId === creation.id) this.tests.delete(test.id);
    const created = buildTestCases(creation, cases);
    for (const test of created) this.tests.set(test.id, test);
    return Promise.resolve(created);
  }

  async appendTests(
    creation: E2eCreation,
    cases: readonly NewE2eTestCase[],
  ): Promise<E2eTestCase[]> {
    const existing = await this.listTests(creation.workspaceId, creation.id);
    const created = buildTestCases(creation, cases, (existing.at(-1)?.position ?? 0) + 1);
    for (const test of created) this.tests.set(test.id, test);
    return created;
  }

  listTests(workspaceId: string, creationId?: string): Promise<E2eTestCase[]> {
    return Promise.resolve(
      [...this.tests.values()]
        .filter(
          (test) =>
            test.workspaceId === workspaceId && (!creationId || test.creationId === creationId),
        )
        .sort((a, b) => a.position - b.position),
    );
  }

  getTest(workspaceId: string, id: string): Promise<E2eTestCase | null> {
    const test = this.tests.get(id);
    return Promise.resolve(test?.workspaceId === workspaceId ? test : null);
  }

  async updateTest(
    workspaceId: string,
    id: string,
    changes: E2eTestChanges,
  ): Promise<E2eTestCase | null> {
    const test = await this.getTest(workspaceId, id);
    if (!test) return null;
    const next = { ...test, ...changes, updatedAt: new Date() };
    this.tests.set(id, next);
    // Keep the creation's "modified at" in step with its latest test activity.
    const creation = this.creations.get(test.creationId);
    if (creation) this.creations.set(creation.id, { ...creation, updatedAt: next.updatedAt });
    return next;
  }
}
