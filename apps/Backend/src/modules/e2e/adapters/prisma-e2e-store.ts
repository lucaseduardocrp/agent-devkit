import type { PrismaClient } from '../../../generated/prisma/client.js';
import {
  ACTIVE_CREATION_STATUSES,
  type E2eCreation,
  type E2eReportState,
  type E2eReportingTarget,
  type E2eStepResult,
  type E2eTestCase,
} from '../domain/e2e.js';
import type { ExternalTestCase } from '../../test-management/domain/test-run.js';
import {
  buildTestCases,
  type E2eCreationChanges,
  type E2eStore,
  type E2eTestChanges,
  type NewE2eCreation,
  type NewE2eTestCase,
} from '../application/e2e-store.js';

type CreationRow = Omit<
  E2eCreation,
  | 'prdFileNames'
  | 'mode'
  | 'scope'
  | 'status'
  | 'repository'
  | 'reporting'
  | 'lastReport'
  | 'executionTarget'
> & {
  executionTarget: string;
  reporting: string | null;
  lastReport: string | null;
  prdFileNames: unknown;
  mode: string;
  scope: string;
  status: string;
  repoProvider: string | null;
  repoId: string | null;
  repoName: string | null;
  repoBranch: string | null;
  repoPath: string | null;
};
type TestRow = Omit<
  E2eTestCase,
  'steps' | 'priority' | 'status' | 'verdict' | 'externalCase' | 'stepResults'
> & {
  steps: unknown;
  externalCase: string | null;
  stepResults: unknown;
  priority: string;
  status: string;
  verdict: string | null;
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** Optional objects are kept as JSON text, so clearing them is a plain NULL. */
function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

const jsonText = (value: unknown): string | null | undefined =>
  value === undefined ? undefined : value === null ? null : JSON.stringify(value);

function toCreation(row: CreationRow): E2eCreation {
  const { repoProvider, repoId, repoName, repoBranch, repoPath, ...rest } = row;
  return {
    ...rest,
    prdFileNames: strings(row.prdFileNames),
    reporting: parseJson<E2eReportingTarget>(row.reporting),
    lastReport: parseJson<E2eReportState>(row.lastReport),
    repository:
      repoProvider && repoId && repoName && repoBranch
        ? {
            provider: repoProvider,
            id: repoId,
            name: repoName,
            branch: repoBranch,
            path: repoPath ?? '',
          }
        : null,
  } as E2eCreation;
}

function repositoryColumns(repository: E2eCreation['repository']) {
  return {
    repoProvider: repository?.provider ?? null,
    repoId: repository?.id ?? null,
    repoName: repository?.name ?? null,
    repoBranch: repository?.branch ?? null,
    repoPath: repository?.path ?? null,
  };
}

function toCreationRow(input: NewE2eCreation) {
  const { repository, reporting, ...rest } = input;
  return { ...rest, reporting: jsonText(reporting), ...repositoryColumns(repository) };
}

function toChangesRow(changes: E2eCreationChanges) {
  const { repository, reporting, lastReport, ...rest } = changes;
  return {
    ...rest,
    reporting: jsonText(reporting),
    lastReport: jsonText(lastReport),
    ...(repository === undefined ? {} : repositoryColumns(repository)),
  };
}

function toTest(row: TestRow): E2eTestCase {
  return {
    ...row,
    steps: strings(row.steps),
    externalCase: parseJson<ExternalTestCase>(row.externalCase),
    stepResults: Array.isArray(row.stepResults) ? (row.stepResults as E2eStepResult[]) : [],
  } as E2eTestCase;
}

function toTestRow(test: E2eTestCase) {
  return {
    ...test,
    externalCase: jsonText(test.externalCase),
    stepResults: test.stepResults as unknown as object[],
  };
}

function toTestChangesRow(changes: E2eTestChanges) {
  const { externalCase, stepResults, ...rest } = changes;
  return {
    ...rest,
    externalCase: jsonText(externalCase),
    ...(stepResults === undefined ? {} : { stepResults: stepResults as unknown as object[] }),
  };
}

export class PrismaE2eStore implements E2eStore {
  constructor(private readonly db: PrismaClient) {}

  async createCreation(input: NewE2eCreation): Promise<E2eCreation> {
    return toCreation(await this.db.e2eCreationRecord.create({ data: toCreationRow(input) }));
  }

  async getCreation(workspaceId: string, id: string): Promise<E2eCreation | null> {
    const row = await this.db.e2eCreationRecord.findFirst({ where: { id, workspaceId } });
    return row ? toCreation(row) : null;
  }

  async listCreations(workspaceId: string): Promise<E2eCreation[]> {
    const rows = await this.db.e2eCreationRecord.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map(toCreation);
  }

  async updateCreation(
    workspaceId: string,
    id: string,
    changes: E2eCreationChanges,
  ): Promise<E2eCreation | null> {
    const result = await this.db.e2eCreationRecord.updateMany({
      where: { id, workspaceId },
      data: toChangesRow(changes),
    });
    return result.count ? this.getCreation(workspaceId, id) : null;
  }

  async deleteCreation(workspaceId: string, id: string): Promise<boolean> {
    return (await this.db.e2eCreationRecord.deleteMany({ where: { id, workspaceId } })).count > 0;
  }

  async incompleteCreations(): Promise<E2eCreation[]> {
    const rows = await this.db.e2eCreationRecord.findMany({
      where: { status: { in: [...ACTIVE_CREATION_STATUSES] } },
    });
    return rows.map(toCreation);
  }

  async replaceTests(
    creation: E2eCreation,
    cases: readonly NewE2eTestCase[],
  ): Promise<E2eTestCase[]> {
    const tests = buildTestCases(creation, cases);
    await this.db.$transaction([
      this.db.e2eTestCaseRecord.deleteMany({ where: { creationId: creation.id } }),
      this.db.e2eTestCaseRecord.createMany({ data: tests.map(toTestRow) }),
    ]);
    return tests;
  }

  async appendTests(
    creation: E2eCreation,
    cases: readonly NewE2eTestCase[],
  ): Promise<E2eTestCase[]> {
    const last = await this.db.e2eTestCaseRecord.findFirst({
      where: { creationId: creation.id },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const tests = buildTestCases(creation, cases, (last?.position ?? 0) + 1);
    await this.db.e2eTestCaseRecord.createMany({ data: tests.map(toTestRow) });
    return tests;
  }

  async listTests(workspaceId: string, creationId?: string): Promise<E2eTestCase[]> {
    const rows = await this.db.e2eTestCaseRecord.findMany({
      where: { workspaceId, ...(creationId ? { creationId } : {}) },
      orderBy: [{ creationId: 'asc' }, { position: 'asc' }],
    });
    return rows.map(toTest);
  }

  async getTest(workspaceId: string, id: string): Promise<E2eTestCase | null> {
    const row = await this.db.e2eTestCaseRecord.findFirst({ where: { id, workspaceId } });
    return row ? toTest(row) : null;
  }

  async updateTest(
    workspaceId: string,
    id: string,
    changes: E2eTestChanges,
  ): Promise<E2eTestCase | null> {
    const result = await this.db.e2eTestCaseRecord.updateMany({
      where: { id, workspaceId },
      data: toTestChangesRow(changes),
    });
    if (!result.count) return null;
    const test = await this.getTest(workspaceId, id);
    // Keep the creation's "modified at" in step with its latest test activity.
    if (test)
      await this.db.e2eCreationRecord.updateMany({
        where: { id: test.creationId, workspaceId },
        data: { updatedAt: new Date() },
      });
    return test;
  }
}
