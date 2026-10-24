import type { Prisma, PrismaClient } from '../../../generated/prisma/client.js';
import type {
  ApiCollection,
  ApiEnvironment,
  ApiRun,
  ApiRunKind,
  ApiRunStatus,
  ApiRunTarget,
  LoadScenario,
} from '../domain/api-test.js';
import type {
  ApiTestStore,
  NewApiRun,
  RunFilter,
  RunOutcome,
} from '../application/api-test-store.js';

type Json = Record<string, unknown>;

interface CollectionRow {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  definition: unknown;
  source: unknown;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

interface RunRow {
  id: string;
  workspaceId: string;
  kind: string;
  collectionId: string;
  scenarioId: string | null;
  environmentId: string | null;
  itemIds: unknown;
  name: string;
  target: string;
  status: string;
  requestedBy: string;
  claimedBy: string | null;
  claimLabel: string | null;
  heartbeatAt: Date | null;
  attempts: number;
  payload: string | null;
  result: unknown;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** Raw rows of `UPDATE ... RETURNING *` use column names. */
interface RawRunRow {
  id: string;
  workspace_id: string;
  kind: string;
  collection_id: string;
  scenario_id: string | null;
  environment_id: string | null;
  item_ids: unknown;
  name: string;
  target: string;
  status: string;
  requested_by: string;
  claimed_by: string | null;
  claim_label: string | null;
  heartbeat_at: Date | null;
  attempts: number;
  payload: string | null;
  result: unknown;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

/** Plain JSON for Prisma (drops undefined values and class instances). */
const asJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;

function collectionFrom(row: CollectionRow): ApiCollection {
  const definition = (row.definition ?? {}) as Json;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    variables: (definition['variables'] ?? []) as ApiCollection['variables'],
    auth: (definition['auth'] ?? { type: 'none' }) as ApiCollection['auth'],
    items: (definition['items'] ?? []) as ApiCollection['items'],
    source: (row.source ?? { kind: 'manual' }) as ApiCollection['source'],
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function runFrom(row: RunRow): ApiRun {
  return {
    ...row,
    kind: row.kind as ApiRunKind,
    target: row.target as ApiRunTarget,
    status: row.status as ApiRunStatus,
    itemIds: Array.isArray(row.itemIds) ? (row.itemIds as string[]) : [],
    result: (row.result ?? null) as ApiRun['result'],
  };
}

function runFromRaw(row: RawRunRow): ApiRun {
  return runFrom({
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    collectionId: row.collection_id,
    scenarioId: row.scenario_id,
    environmentId: row.environment_id,
    itemIds: row.item_ids,
    name: row.name,
    target: row.target,
    status: row.status,
    requestedBy: row.requested_by,
    claimedBy: row.claimed_by,
    claimLabel: row.claim_label,
    heartbeatAt: row.heartbeat_at,
    attempts: row.attempts,
    payload: row.payload,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  });
}

export class PrismaApiTestStore implements ApiTestStore {
  constructor(private readonly db: PrismaClient) {}

  async listCollections(workspaceId: string) {
    const rows = await this.db.apiCollectionRecord.findMany({
      where: { workspaceId },
      orderBy: { name: 'asc' },
    });
    return rows.map(collectionFrom);
  }

  async getCollection(workspaceId: string, id: string) {
    const row = await this.db.apiCollectionRecord.findFirst({ where: { id, workspaceId } });
    return row ? collectionFrom(row) : null;
  }

  async saveCollection(collection: ApiCollection) {
    const data = {
      name: collection.name,
      description: collection.description ?? null,
      definition: asJson({
        variables: collection.variables,
        auth: collection.auth,
        items: collection.items,
      }),
      source: asJson(collection.source),
    };
    const row = await this.db.apiCollectionRecord.upsert({
      where: { id: collection.id },
      create: {
        id: collection.id,
        workspaceId: collection.workspaceId,
        createdBy: collection.createdBy,
        ...data,
      },
      update: data,
    });
    return collectionFrom(row);
  }

  async deleteCollection(workspaceId: string, id: string) {
    return (await this.db.apiCollectionRecord.deleteMany({ where: { id, workspaceId } })).count > 0;
  }

  async listEnvironments(workspaceId: string) {
    const rows = await this.db.apiEnvironmentRecord.findMany({
      where: { workspaceId },
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => ({
      ...row,
      variables: row.variables as unknown as ApiEnvironment['variables'],
    }));
  }

  async getEnvironment(workspaceId: string, id: string) {
    const row = await this.db.apiEnvironmentRecord.findFirst({ where: { id, workspaceId } });
    return row
      ? { ...row, variables: row.variables as unknown as ApiEnvironment['variables'] }
      : null;
  }

  async saveEnvironment(environment: ApiEnvironment) {
    const data = {
      name: environment.name,
      variables: JSON.parse(JSON.stringify(environment.variables)) as Prisma.InputJsonArray,
    };
    const row = await this.db.apiEnvironmentRecord.upsert({
      where: { id: environment.id },
      create: { id: environment.id, workspaceId: environment.workspaceId, ...data },
      update: data,
    });
    return { ...row, variables: row.variables as unknown as ApiEnvironment['variables'] };
  }

  async deleteEnvironment(workspaceId: string, id: string) {
    return (
      (await this.db.apiEnvironmentRecord.deleteMany({ where: { id, workspaceId } })).count > 0
    );
  }

  private static scenarioFrom(row: {
    id: string;
    workspaceId: string;
    collectionId: string;
    name: string;
    definition: unknown;
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;
  }): LoadScenario {
    const definition = (row.definition ?? {}) as Omit<
      LoadScenario,
      'id' | 'workspaceId' | 'collectionId' | 'name' | 'createdBy' | 'createdAt' | 'updatedAt'
    >;
    return {
      ...definition,
      id: row.id,
      workspaceId: row.workspaceId,
      collectionId: row.collectionId,
      name: row.name,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async listScenarios(workspaceId: string) {
    const rows = await this.db.loadScenarioRecord.findMany({
      where: { workspaceId },
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => PrismaApiTestStore.scenarioFrom(row));
  }

  async getScenario(workspaceId: string, id: string) {
    const row = await this.db.loadScenarioRecord.findFirst({ where: { id, workspaceId } });
    return row ? PrismaApiTestStore.scenarioFrom(row) : null;
  }

  async saveScenario(scenario: LoadScenario) {
    const {
      id,
      workspaceId,
      collectionId,
      name,
      createdBy,
      createdAt: _c,
      updatedAt: _u,
      ...definition
    } = scenario;
    const data = { name, collectionId, definition: asJson(definition) };
    const row = await this.db.loadScenarioRecord.upsert({
      where: { id },
      create: { id, workspaceId, createdBy, ...data },
      update: data,
    });
    return PrismaApiTestStore.scenarioFrom(row);
  }

  async deleteScenario(workspaceId: string, id: string) {
    return (await this.db.loadScenarioRecord.deleteMany({ where: { id, workspaceId } })).count > 0;
  }

  async createRun(run: NewApiRun) {
    const row = await this.db.apiRunRecord.create({
      data: {
        workspaceId: run.workspaceId,
        kind: run.kind,
        collectionId: run.collectionId,
        scenarioId: run.scenarioId,
        environmentId: run.environmentId,
        itemIds: [...run.itemIds],
        name: run.name,
        target: run.target,
        requestedBy: run.requestedBy,
        payload: run.payload,
      },
    });
    return runFrom(row);
  }

  async getRun(workspaceId: string, id: string) {
    const row = await this.db.apiRunRecord.findFirst({ where: { id, workspaceId } });
    return row ? runFrom(row) : null;
  }

  async listRuns(workspaceId: string, filter: RunFilter = {}) {
    const rows = await this.db.apiRunRecord.findMany({
      where: {
        workspaceId,
        ...(filter.kind ? { kind: filter.kind } : {}),
        ...(filter.collectionId ? { collectionId: filter.collectionId } : {}),
        ...(filter.scenarioId ? { scenarioId: filter.scenarioId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filter.limit ?? 50, 200),
      omit: { payload: true },
    });
    return rows.map((row) => runFrom({ ...row, payload: null }));
  }

  async claimRemote(workerId: string) {
    const rows = await this.db.$queryRaw<RawRunRow[]>`
      UPDATE "api_runs"
      SET "status" = 'running', "claimed_by" = ${workerId}, "claim_label" = 'ADK worker',
          "heartbeat_at" = now(), "attempts" = "attempts" + 1,
          "started_at" = COALESCE("started_at", now()), "updated_at" = now()
      WHERE "id" = (
        SELECT "id" FROM "api_runs" WHERE "status" = 'queued' AND "target" = 'remote'
        ORDER BY "created_at" FOR UPDATE SKIP LOCKED LIMIT 1
      )
      RETURNING *`;
    return rows[0] ? runFromRaw(rows[0]) : null;
  }

  async claimLocal(
    scope: { workspaceId: string; userId: string },
    runner: { id: string; label: string },
  ) {
    const rows = await this.db.$queryRaw<RawRunRow[]>`
      UPDATE "api_runs"
      SET "status" = 'running', "claimed_by" = ${runner.id}, "claim_label" = ${runner.label},
          "heartbeat_at" = now(), "attempts" = "attempts" + 1,
          "started_at" = COALESCE("started_at", now()), "updated_at" = now()
      WHERE "id" = (
        SELECT "id" FROM "api_runs"
        WHERE "status" = 'queued' AND "target" = 'local'
          AND "workspace_id" = ${scope.workspaceId} AND "requested_by" = ${scope.userId}
        ORDER BY "created_at" FOR UPDATE SKIP LOCKED LIMIT 1
      )
      RETURNING *`;
    return rows[0] ? runFromRaw(rows[0]) : null;
  }

  async heartbeat(id: string, claimer: string, partial?: ApiRun['result']) {
    await this.db.apiRunRecord.updateMany({
      where: { id, claimedBy: claimer, status: 'running' },
      data: { heartbeatAt: new Date(), ...(partial ? { result: asJson(partial) } : {}) },
    });
    const row = await this.db.apiRunRecord.findFirst({
      where: { id, claimedBy: claimer },
      select: { status: true },
    });
    return row ? (row.status as ApiRunStatus) : null;
  }

  async finish(id: string, claimer: string, outcome: RunOutcome) {
    const result = await this.db.apiRunRecord.updateMany({
      where: { id, claimedBy: claimer, status: 'running' },
      data: {
        status: outcome.status,
        result: outcome.result ? asJson(outcome.result) : undefined,
        error: outcome.error,
        payload: null,
        finishedAt: new Date(),
      },
    });
    return result.count > 0;
  }

  async cancel(workspaceId: string, id: string) {
    const result = await this.db.apiRunRecord.updateMany({
      where: { id, workspaceId, status: { in: ['queued', 'running'] } },
      data: { status: 'cancelled', payload: null, finishedAt: new Date() },
    });
    return result.count > 0;
  }

  async sweep(staleBefore: Date, maxAttempts: number) {
    const stale = { status: 'running', heartbeatAt: { lt: staleBefore } };
    const failed = await this.db.apiRunRecord.updateMany({
      where: { ...stale, attempts: { gte: maxAttempts } },
      data: {
        status: 'error',
        error: 'The run stopped responding.',
        payload: null,
        finishedAt: new Date(),
      },
    });
    const requeued = await this.db.apiRunRecord.updateMany({
      where: { ...stale, attempts: { lt: maxAttempts } },
      data: { status: 'queued', claimedBy: null, claimLabel: null, heartbeatAt: null },
    });
    return { requeued: requeued.count, failed: failed.count };
  }

  async deleteRun(workspaceId: string, id: string) {
    return (
      (
        await this.db.apiRunRecord.deleteMany({
          where: { id, workspaceId, status: { notIn: ['queued', 'running'] } },
        })
      ).count > 0
    );
  }
}
