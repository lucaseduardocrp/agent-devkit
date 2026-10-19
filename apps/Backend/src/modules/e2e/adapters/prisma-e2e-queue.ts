import crypto from 'node:crypto';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import type {
  E2eJob,
  E2eJobKind,
  E2eJobQueue,
  E2eJobStatus,
  NewE2eJob,
} from '../application/e2e-queue.js';

/** Raw rows use column names; Prisma model rows use field names. */
interface RawJobRow {
  id: string;
  workspace_id: string;
  creation_id: string;
  kind: string;
  test_ids: unknown;
  status: string;
  attempts: number;
  worker_id: string | null;
  heartbeat_at: Date | null;
  requested_by: string | null;
  created_at: Date;
}
interface ModelJobRow {
  id: string;
  workspaceId: string;
  creationId: string;
  kind: string;
  testIds: unknown;
  status: string;
  attempts: number;
  workerId: string | null;
  heartbeatAt: Date | null;
  requestedBy: string | null;
  createdAt: Date;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function fromRaw(row: RawJobRow): E2eJob {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    creationId: row.creation_id,
    kind: row.kind as E2eJobKind,
    testIds: strings(row.test_ids),
    status: row.status as E2eJobStatus,
    attempts: row.attempts,
    workerId: row.worker_id,
    heartbeatAt: row.heartbeat_at,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
  };
}

function fromModel(row: ModelJobRow): E2eJob {
  return {
    ...row,
    kind: row.kind as E2eJobKind,
    status: row.status as E2eJobStatus,
    testIds: strings(row.testIds),
  };
}

/**
 * Postgres-backed queue. Workers claim with FOR UPDATE SKIP LOCKED, so any number of
 * worker instances can consume concurrently without taking the same job twice.
 */
export class PrismaE2eJobQueue implements E2eJobQueue {
  constructor(private readonly db: PrismaClient) {}

  async enqueue(input: NewE2eJob): Promise<E2eJob | null> {
    // The partial unique index turns "one active job per creation" into an atomic check.
    const rows = await this.db.$queryRaw<RawJobRow[]>`
      INSERT INTO "e2e_jobs" ("id", "workspace_id", "creation_id", "kind", "test_ids", "requested_by")
      VALUES (${crypto.randomUUID()}, ${input.workspaceId}, ${input.creationId}, ${input.kind},
              ${JSON.stringify(input.testIds)}::jsonb, ${input.requestedBy ?? null})
      ON CONFLICT ("creation_id") WHERE "status" IN ('queued', 'running') DO NOTHING
      RETURNING *`;
    return rows[0] ? fromRaw(rows[0]) : null;
  }

  async hasActive(workspaceId: string, creationId: string): Promise<boolean> {
    const count = await this.db.e2eJobRecord.count({
      where: { workspaceId, creationId, status: { in: ['queued', 'running'] } },
    });
    return count > 0;
  }

  async claim(workerId: string): Promise<E2eJob | null> {
    const rows = await this.db.$queryRaw<RawJobRow[]>`
      UPDATE "e2e_jobs"
      SET "status" = 'running', "worker_id" = ${workerId}, "heartbeat_at" = now(),
          "attempts" = "attempts" + 1, "updated_at" = now()
      WHERE "id" = (
        SELECT "id" FROM "e2e_jobs" WHERE "status" = 'queued'
        ORDER BY "created_at" FOR UPDATE SKIP LOCKED LIMIT 1
      )
      RETURNING *`;
    return rows[0] ? fromRaw(rows[0]) : null;
  }

  async heartbeat(jobId: string, workerId: string): Promise<boolean> {
    const result = await this.db.e2eJobRecord.updateMany({
      where: { id: jobId, workerId, status: 'running' },
      data: { heartbeatAt: new Date() },
    });
    return result.count > 0;
  }

  async finish(jobId: string, workerId: string, status: 'succeeded' | 'failed'): Promise<void> {
    await this.db.e2eJobRecord.updateMany({
      where: { id: jobId, workerId, status: 'running' },
      data: { status },
    });
  }

  async cancel(workspaceId: string, creationId: string): Promise<boolean> {
    const result = await this.db.e2eJobRecord.updateMany({
      where: { workspaceId, creationId, status: { in: ['queued', 'running'] } },
      data: { status: 'cancelled' },
    });
    return result.count > 0;
  }

  async sweep(staleBefore: Date, maxAttempts: number) {
    const stale = await this.db.e2eJobRecord.findMany({
      where: { status: 'running', heartbeatAt: { lt: staleBefore } },
    });
    const requeued: E2eJob[] = [];
    const failed: E2eJob[] = [];
    for (const row of stale) {
      const exhausted = row.attempts >= maxAttempts;
      // Guarded update: a worker that resumed its heartbeat in the meantime keeps the job.
      const result = await this.db.e2eJobRecord.updateMany({
        where: { id: row.id, status: 'running', heartbeatAt: { lt: staleBefore } },
        data: exhausted
          ? { status: 'failed' }
          : { status: 'queued', workerId: null, heartbeatAt: null },
      });
      if (!result.count) continue;
      const job = fromModel(row);
      if (exhausted) failed.push({ ...job, status: 'failed' });
      else requeued.push({ ...job, status: 'queued', workerId: null, heartbeatAt: null });
    }
    return { requeued, failed };
  }
}
