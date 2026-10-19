import type { PrismaClient } from '../../../generated/prisma/client.js';
import type {
  E2eLocalRunner,
  E2eRunnerIdentity,
  E2eRunnerTask,
  E2eRunnerTaskKind,
  E2eRunnerTaskStatus,
  E2eRunnerTaskStore,
  NewE2eRunnerTask,
} from '../application/runner-tasks.js';

interface RawTaskRow {
  id: string;
  workspace_id: string;
  creation_id: string;
  test_id: string | null;
  user_id: string;
  kind: string;
  payload: string;
  status: string;
  runner_id: string | null;
  runner_label: string | null;
  result: string | null;
  error: string | null;
  heartbeat_at: Date | null;
  created_at: Date;
}

interface ModelTaskRow {
  id: string;
  workspaceId: string;
  creationId: string;
  testId: string | null;
  userId: string;
  kind: string;
  payload: string;
  status: string;
  runnerId: string | null;
  runnerLabel: string | null;
  result: string | null;
  error: string | null;
  heartbeatAt: Date | null;
  createdAt: Date;
}

function fromModel(row: ModelTaskRow): E2eRunnerTask {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    creationId: row.creationId,
    testId: row.testId,
    userId: row.userId,
    kind: row.kind as E2eRunnerTaskKind,
    payload: row.payload,
    status: row.status as E2eRunnerTaskStatus,
    runnerId: row.runnerId,
    runnerLabel: row.runnerLabel,
    result: row.result,
    error: row.error,
    heartbeatAt: row.heartbeatAt,
    createdAt: row.createdAt,
  };
}

function fromRaw(row: RawTaskRow): E2eRunnerTask {
  return fromModel({
    id: row.id,
    workspaceId: row.workspace_id,
    creationId: row.creation_id,
    testId: row.test_id,
    userId: row.user_id,
    kind: row.kind,
    payload: row.payload,
    status: row.status,
    runnerId: row.runner_id,
    runnerLabel: row.runner_label,
    result: row.result,
    error: row.error,
    heartbeatAt: row.heartbeat_at,
    createdAt: row.created_at,
  });
}

/** Postgres-backed runner tasks; claims use FOR UPDATE SKIP LOCKED like the job queue. */
export class PrismaE2eRunnerTaskStore implements E2eRunnerTaskStore {
  constructor(private readonly db: PrismaClient) {}

  async create(input: NewE2eRunnerTask): Promise<E2eRunnerTask> {
    return fromModel(await this.db.e2eRunnerTaskRecord.create({ data: input }));
  }

  async get(id: string): Promise<E2eRunnerTask | null> {
    const row = await this.db.e2eRunnerTaskRecord.findUnique({ where: { id } });
    return row ? fromModel(row) : null;
  }

  async claim(
    scope: { workspaceId: string; userId: string; creationId?: string; createdAfter: Date },
    runner: { id: string; label: string },
  ): Promise<E2eRunnerTask | null> {
    const creationId = scope.creationId ?? null;
    const rows = await this.db.$queryRaw<RawTaskRow[]>`
      UPDATE "e2e_runner_tasks"
      SET "status" = 'running', "runner_id" = ${runner.id}, "runner_label" = ${runner.label},
          "heartbeat_at" = now(), "updated_at" = now()
      WHERE "id" = (
        SELECT "id" FROM "e2e_runner_tasks"
        WHERE "status" = 'queued' AND "workspace_id" = ${scope.workspaceId}
          AND "user_id" = ${scope.userId} AND "created_at" >= ${scope.createdAfter}
          AND (${creationId}::text IS NULL OR "creation_id" = ${creationId})
        ORDER BY "created_at" FOR UPDATE SKIP LOCKED LIMIT 1
      )
      RETURNING *`;
    return rows[0] ? fromRaw(rows[0]) : null;
  }

  async heartbeat(id: string, runnerId: string): Promise<E2eRunnerTaskStatus | null> {
    await this.db.e2eRunnerTaskRecord.updateMany({
      where: { id, runnerId, status: 'running' },
      data: { heartbeatAt: new Date() },
    });
    const row = await this.db.e2eRunnerTaskRecord.findFirst({
      where: { id, runnerId },
      select: { status: true },
    });
    return row ? (row.status as E2eRunnerTaskStatus) : null;
  }

  async complete(
    id: string,
    runnerId: string,
    outcome: { status: 'succeeded' | 'failed'; result: string; error: string | null },
  ): Promise<boolean> {
    const updated = await this.db.e2eRunnerTaskRecord.updateMany({
      where: { id, runnerId, status: 'running' },
      // The encrypted input is not needed anymore; drop it with the credentials it holds.
      data: { ...outcome, payload: '' },
    });
    return updated.count > 0;
  }

  async remove(id: string): Promise<void> {
    await this.db.e2eRunnerTaskRecord.deleteMany({ where: { id } });
  }

  async seen(runner: E2eRunnerIdentity & { workspaceId: string; userId: string }): Promise<void> {
    const { id, workspaceId, userId, name, platform, version } = runner;
    await this.db.e2eLocalRunnerRecord.upsert({
      where: { id_workspaceId: { id, workspaceId } },
      create: { id, workspaceId, userId, name, platform, version },
      update: { userId, name, platform, version, lastSeenAt: new Date() },
    });
  }

  async listRunners(workspaceId: string, userId: string, since: Date): Promise<E2eLocalRunner[]> {
    const rows = await this.db.e2eLocalRunnerRecord.findMany({
      where: { workspaceId, userId, lastSeenAt: { gte: since } },
      orderBy: { lastSeenAt: 'desc' },
      select: { id: true, name: true, platform: true, version: true, lastSeenAt: true },
    });
    return rows;
  }
}
