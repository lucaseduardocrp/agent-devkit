CREATE TABLE "automation_scripts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "test_plan_id" TEXT,
    "provider" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "repository_name" TEXT NOT NULL,
    "base_branch" TEXT NOT NULL,
    "target_path" TEXT NOT NULL,
    "application_url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "automation_scripts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "automation_scripts_workspace_updated_idx"
ON "automation_scripts"("workspace_id", "updated_at");

CREATE INDEX "automation_scripts_workspace_test_plan_idx"
ON "automation_scripts"("workspace_id", "test_plan_id");

CREATE INDEX "automation_scripts_workspace_deleted_idx"
ON "automation_scripts"("workspace_id", "deleted_at");

ALTER TABLE "automation_scripts"
ADD CONSTRAINT "automation_scripts_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "automation_scripts"
ADD CONSTRAINT "automation_scripts_test_plan_id_fkey"
FOREIGN KEY ("test_plan_id") REFERENCES "saved_test_plans"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
