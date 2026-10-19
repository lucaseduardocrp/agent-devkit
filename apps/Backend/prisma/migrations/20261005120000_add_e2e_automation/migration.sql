CREATE TABLE "e2e_creations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "path" TEXT NOT NULL DEFAULT '/',
    "username" TEXT,
    "password_secret" TEXT,
    "prd" TEXT NOT NULL,
    "prd_file_names" JSONB NOT NULL DEFAULT '[]',
    "diff" TEXT,
    "instructions" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'pt-BR',
    "prd_summary" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "e2e_creations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "e2e_test_cases" (
    "id" TEXT NOT NULL,
    "creation_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "script" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "analysis" TEXT,
    "verdict" TEXT,
    "logs" TEXT,
    "video_key" TEXT,
    "duration_ms" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_run_at" TIMESTAMP(3),

    CONSTRAINT "e2e_test_cases_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "e2e_creations_workspace_updated_idx" ON "e2e_creations"("workspace_id", "updated_at");
CREATE INDEX "e2e_creations_status_idx" ON "e2e_creations"("status");
CREATE INDEX "e2e_test_cases_creation_position_idx" ON "e2e_test_cases"("creation_id", "position");
CREATE INDEX "e2e_test_cases_workspace_idx" ON "e2e_test_cases"("workspace_id");

ALTER TABLE "e2e_creations" ADD CONSTRAINT "e2e_creations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "e2e_test_cases" ADD CONSTRAINT "e2e_test_cases_creation_id_fkey" FOREIGN KEY ("creation_id") REFERENCES "e2e_creations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
