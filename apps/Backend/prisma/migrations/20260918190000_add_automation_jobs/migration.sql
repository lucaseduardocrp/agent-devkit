CREATE TABLE "automation_jobs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "script_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "current_step" TEXT NOT NULL DEFAULT 'QUEUED',
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "worker_id" TEXT,
    "locked_at" TIMESTAMP(3),
    "heartbeat_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "automation_jobs_workspace_created_idx" ON "automation_jobs"("workspace_id", "created_at");
CREATE INDEX "automation_jobs_status_created_idx" ON "automation_jobs"("status", "created_at");
CREATE INDEX "automation_jobs_script_idx" ON "automation_jobs"("script_id");

ALTER TABLE "automation_jobs"
ADD CONSTRAINT "automation_jobs_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "automation_jobs"
ADD CONSTRAINT "automation_jobs_script_id_fkey"
FOREIGN KEY ("script_id") REFERENCES "automation_scripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
