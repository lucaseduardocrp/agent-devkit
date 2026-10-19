-- Every pre-existing plan is placed in a deterministic workspace-level suite before
-- the relation becomes mandatory. The deterministic id keeps this migration retry-safe.
INSERT INTO "test_suites" ("id", "workspace_id", "name", "created_at", "updated_at")
SELECT
  'legacy-test-suite-' || "workspace_id",
  "workspace_id",
  'Test',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "saved_test_plans" plan
WHERE plan."suite_id" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "test_suites" suite
    WHERE suite."id" = 'legacy-test-suite-' || plan."workspace_id"
  )
GROUP BY "workspace_id";

UPDATE "saved_test_plans"
SET "suite_id" = 'legacy-test-suite-' || "workspace_id"
WHERE "suite_id" IS NULL;

ALTER TABLE "saved_test_plans"
ALTER COLUMN "suite_id" SET NOT NULL;

ALTER TABLE "saved_test_plans"
DROP CONSTRAINT "saved_test_plans_suite_id_fkey",
ADD CONSTRAINT "saved_test_plans_suite_id_fkey"
FOREIGN KEY ("suite_id") REFERENCES "test_suites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
