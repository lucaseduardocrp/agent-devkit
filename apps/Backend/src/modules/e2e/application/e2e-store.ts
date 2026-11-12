import crypto from 'node:crypto';
import {
  ACTIVE_CREATION_STATUSES,
  testCaseCode,
  type E2eCreation,
  type E2ePriority,
  type E2eTestCase,
} from '../domain/e2e.js';
import type { E2eExplorationScript, NewE2eExplorationScript } from '../domain/e2e-insight.js';
import type { E2eSource, NewE2eSource } from '../domain/e2e-source.js';
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
  readonly environmentId?: E2eCreation['environmentId'];
  /** Defaults to false (the PRD is the source). */
  readonly useBrain?: boolean;
  /** The hidden run of the workspace's Source. */
  readonly internal?: boolean;
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
  | 'useBrain'
  | 'diff'
  | 'instructions'
  | 'repository'
>;

export type E2eCreationChanges = Partial<
  Pick<
    E2eCreation,
    | 'status'
    | 'error'
    | 'prdSummary'
    | 'finishedAt'
    | 'reporting'
    | 'lastReport'
    | 'environmentId'
    | 'ownerId'
    | 'actorId'
    | 'locale'
  > &
    E2eCreationSettings
>;

export interface NewE2eTestCase {
  readonly title: string;
  readonly description: string;
  readonly steps: readonly string[];
  readonly priority: E2ePriority;
  /** Feature area that groups the test in the run view. */
  readonly category?: string | null;
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
    | 'beforeRunInstructions'
    | 'afterRunInstructions'
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
  /** The runs the user sees: the hidden run of the Source is left out. */
  listCreations(workspaceId: string): Promise<E2eCreation[]>;
  /** The hidden run that explores the workspace's Source; null before its first exploration. */
  getSourceAnchor(workspaceId: string): Promise<E2eCreation | null>;
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
  /** Keeps the script of a finished Site Exploration; explorations are never replaced. */
  saveExplorationScript(input: NewE2eExplorationScript): Promise<E2eExplorationScript>;
  /** Newest first; narrowed to one run when `creationId` is given. */
  listExplorationScripts(workspaceId: string, creationId?: string): Promise<E2eExplorationScript[]>;
  getExplorationScript(workspaceId: string, id: string): Promise<E2eExplorationScript | null>;
  deleteExplorationScript(workspaceId: string, id: string): Promise<boolean>;
  /** Replaces the Source of the workspace: there is only one. */
  saveSource(input: NewE2eSource): Promise<E2eSource>;
  getSource(workspaceId: string): Promise<E2eSource | null>;
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
    category: item.category?.trim() || null,
    scriptPath: item.scriptPath ?? null,
    beforeRunInstructions: null,
    afterRunInstructions: null,
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
  private readonly explorationScripts = new Map<string, E2eExplorationScript>();
  private readonly sources = new Map<string, E2eSource>();

  saveSource(input: NewE2eSource): Promise<E2eSource> {
    const source: E2eSource = { ...input, updatedAt: new Date() };
    this.sources.set(source.workspaceId, source);
    return Promise.resolve(source);
  }

  getSource(workspaceId: string): Promise<E2eSource | null> {
    return Promise.resolve(this.sources.get(workspaceId) ?? null);
  }

  saveExplorationScript(input: NewE2eExplorationScript): Promise<E2eExplorationScript> {
    const script: E2eExplorationScript = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: new Date(),
    };
    this.explorationScripts.set(script.id, script);
    return Promise.resolve(script);
  }

  listExplorationScripts(
    workspaceId: string,
    creationId?: string,
  ): Promise<E2eExplorationScript[]> {
    return Promise.resolve(
      [...this.explorationScripts.values()]
        .filter(
          (script) =>
            script.workspaceId === workspaceId && (!creationId || script.creationId === creationId),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    );
  }

  getExplorationScript(workspaceId: string, id: string): Promise<E2eExplorationScript | null> {
    const script = this.explorationScripts.get(id);
    return Promise.resolve(script?.workspaceId === workspaceId ? script : null);
  }

  async deleteExplorationScript(workspaceId: string, id: string): Promise<boolean> {
    if (!(await this.getExplorationScript(workspaceId, id))) return false;
    return this.explorationScripts.delete(id);
  }

  createCreation(input: NewE2eCreation): Promise<E2eCreation> {
    const now = new Date();
    const creation: E2eCreation = {
      ...input,
      executionTarget: input.executionTarget ?? 'remote',
      prdFileNames: [...input.prdFileNames],
      useBrain: input.useBrain ?? false,
      internal: input.internal ?? false,
      reporting: input.reporting ?? null,
      environmentId: input.environmentId ?? null,
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
        .filter((creation) => creation.workspaceId === workspaceId && !creation.internal)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
    );
  }

  getSourceAnchor(workspaceId: string): Promise<E2eCreation | null> {
    return Promise.resolve(
      [...this.creations.values()].find(
        (creation) => creation.workspaceId === workspaceId && creation.internal,
      ) ?? null,
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
    for (const script of [...this.explorationScripts.values()])
      if (script.creationId === id) this.explorationScripts.delete(script.id);
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
