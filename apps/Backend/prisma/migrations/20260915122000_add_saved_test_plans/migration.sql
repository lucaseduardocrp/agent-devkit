CREATE TABLE "saved_test_plans" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "criteria" TEXT,
    "assigned_to" TEXT,
    "plans" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "saved_test_plans_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "saved_test_plans_workspace_updated_idx" ON "saved_test_plans"("workspace_id", "updated_at");
ALTER TABLE "saved_test_plans" ADD CONSTRAINT "saved_test_plans_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
