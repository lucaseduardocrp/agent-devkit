-- Saved environments (URL, test account, custom variables) reused by E2E runs.
CREATE TABLE "e2e_environments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "username" TEXT,
    "password_secret" TEXT,
    "variables_secret" TEXT,
    "variable_names" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "e2e_environments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "e2e_environments_workspace_created_idx" ON "e2e_environments"("workspace_id", "created_at");

ALTER TABLE "e2e_environments" ADD CONSTRAINT "e2e_environments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The environment a run was configured from, and the feature area that groups its tests.
ALTER TABLE "e2e_creations" ADD COLUMN "environment_id" TEXT;
ALTER TABLE "e2e_test_cases" ADD COLUMN "category" TEXT;
