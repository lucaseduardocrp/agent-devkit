CREATE TABLE "test_suites" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "test_suites_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "saved_test_plans"
ADD COLUMN "suite_id" TEXT,
ADD COLUMN "source_type" TEXT,
ADD COLUMN "source_id" TEXT;

CREATE UNIQUE INDEX "test_suites_workspace_parent_name_key" ON "test_suites"("workspace_id", "parent_id", "name");
CREATE INDEX "test_suites_workspace_parent_idx" ON "test_suites"("workspace_id", "parent_id");
CREATE INDEX "saved_test_plans_workspace_suite_idx" ON "saved_test_plans"("workspace_id", "suite_id");

ALTER TABLE "test_suites" ADD CONSTRAINT "test_suites_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_suites" ADD CONSTRAINT "test_suites_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "test_suites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "saved_test_plans" ADD CONSTRAINT "saved_test_plans_suite_id_fkey" FOREIGN KEY ("suite_id") REFERENCES "test_suites"("id") ON DELETE SET NULL ON UPDATE CASCADE;
