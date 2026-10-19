-- Runs can execute on the requesting user's computer through `devkit runner`.
ALTER TABLE "e2e_creations" ADD COLUMN "execution_target" TEXT NOT NULL DEFAULT 'remote';
ALTER TABLE "e2e_test_cases" ADD COLUMN "executed_on" TEXT;
ALTER TABLE "e2e_jobs" ADD COLUMN "requested_by" TEXT;

CREATE TABLE "e2e_runner_tasks" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "creation_id" TEXT NOT NULL,
    "test_id" TEXT,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "runner_id" TEXT,
    "runner_label" TEXT,
    "result" TEXT,
    "error" TEXT,
    "heartbeat_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "e2e_runner_tasks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "e2e_runner_tasks_claim_idx" ON "e2e_runner_tasks"("workspace_id", "user_id", "status", "created_at");

ALTER TABLE "e2e_runner_tasks" ADD CONSTRAINT "e2e_runner_tasks_creation_id_fkey" FOREIGN KEY ("creation_id") REFERENCES "e2e_creations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "e2e_local_runners" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "e2e_local_runners_pkey" PRIMARY KEY ("id", "workspace_id")
);

CREATE INDEX "e2e_local_runners_user_idx" ON "e2e_local_runners"("workspace_id", "user_id", "last_seen_at");
