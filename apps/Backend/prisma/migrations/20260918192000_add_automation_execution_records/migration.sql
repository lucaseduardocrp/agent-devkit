ALTER TABLE "automation_scripts" ADD COLUMN "content_hash" TEXT;
UPDATE "automation_scripts" SET "content_hash" = md5("content");
ALTER TABLE "automation_scripts" ALTER COLUMN "content_hash" SET NOT NULL;

CREATE TABLE "automation_runs" (
  "id" TEXT NOT NULL, "workspace_id" TEXT NOT NULL, "script_id" TEXT NOT NULL,
  "job_id" TEXT NOT NULL, "script_revision" INTEGER NOT NULL, "content_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL, "started_at" TIMESTAMP(3) NOT NULL, "finished_at" TIMESTAMP(3),
  "duration_ms" INTEGER, "exit_code" INTEGER, "passed" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0, "skipped" INTEGER NOT NULL DEFAULT 0,
  "summary" JSONB NOT NULL, "safe_logs" TEXT, "diff" TEXT, "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "automation_runs_job_id_key" ON "automation_runs"("job_id");
CREATE INDEX "automation_runs_workspace_created_idx" ON "automation_runs"("workspace_id", "created_at");
CREATE INDEX "automation_runs_script_created_idx" ON "automation_runs"("script_id", "created_at");

CREATE TABLE "automation_artifacts" (
  "id" TEXT NOT NULL, "workspace_id" TEXT NOT NULL, "run_id" TEXT NOT NULL,
  "type" TEXT NOT NULL, "media_type" TEXT NOT NULL, "storage_key" TEXT NOT NULL,
  "checksum" TEXT NOT NULL, "size" INTEGER NOT NULL, "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "automation_artifacts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "automation_artifacts_workspace_run_idx" ON "automation_artifacts"("workspace_id", "run_id");
CREATE INDEX "automation_artifacts_expiry_idx" ON "automation_artifacts"("expires_at");

CREATE TABLE "automation_approvals" (
  "id" TEXT NOT NULL, "workspace_id" TEXT NOT NULL, "script_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL, "content_hash" TEXT NOT NULL, "run_id" TEXT NOT NULL,
  "approved_by" TEXT NOT NULL, "approved_at" TIMESTAMP(3) NOT NULL,
  "invalidated_at" TIMESTAMP(3), "invalid_reason" TEXT,
  CONSTRAINT "automation_approvals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "automation_approvals_workspace_script_idx" ON "automation_approvals"("workspace_id", "script_id", "approved_at");

CREATE TABLE "automation_publications" (
  "id" TEXT NOT NULL, "workspace_id" TEXT NOT NULL, "script_id" TEXT NOT NULL,
  "approval_id" TEXT NOT NULL, "revision" INTEGER NOT NULL, "branch_name" TEXT NOT NULL,
  "commit_id" TEXT, "pull_request_id" TEXT, "pull_request_url" TEXT,
  "status" TEXT NOT NULL, "error_code" TEXT, "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "automation_publications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "automation_publications_workspace_script_idx" ON "automation_publications"("workspace_id", "script_id", "created_at");

ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "automation_scripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "automation_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_artifacts" ADD CONSTRAINT "automation_artifacts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_artifacts" ADD CONSTRAINT "automation_artifacts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "automation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_approvals" ADD CONSTRAINT "automation_approvals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_approvals" ADD CONSTRAINT "automation_approvals_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "automation_scripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_publications" ADD CONSTRAINT "automation_publications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_publications" ADD CONSTRAINT "automation_publications_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "automation_scripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_publications" ADD CONSTRAINT "automation_publications_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "automation_approvals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
