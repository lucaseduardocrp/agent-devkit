-- Durable queue consumed by on-demand E2E workers.
CREATE TABLE "e2e_jobs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "creation_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "test_ids" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "worker_id" TEXT,
    "heartbeat_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "e2e_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "e2e_jobs_status_created_idx" ON "e2e_jobs"("status", "created_at");
-- At most one active job per creation, so its tests never run twice concurrently.
CREATE UNIQUE INDEX "e2e_jobs_one_active_per_creation"
    ON "e2e_jobs"("creation_id") WHERE "status" IN ('queued', 'running');

ALTER TABLE "e2e_jobs" ADD CONSTRAINT "e2e_jobs_creation_id_fkey" FOREIGN KEY ("creation_id") REFERENCES "e2e_creations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Test videos shared by the API and the workers (no local disk involved).
CREATE TABLE "e2e_artifacts" (
    "key" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "e2e_artifacts_pkey" PRIMARY KEY ("key")
);
