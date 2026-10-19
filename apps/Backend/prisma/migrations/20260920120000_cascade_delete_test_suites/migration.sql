ALTER TABLE "test_suites"
DROP CONSTRAINT "test_suites_parent_id_fkey",
ADD CONSTRAINT "test_suites_parent_id_fkey"
FOREIGN KEY ("parent_id") REFERENCES "test_suites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "saved_test_plans"
DROP CONSTRAINT "saved_test_plans_suite_id_fkey",
ADD CONSTRAINT "saved_test_plans_suite_id_fkey"
FOREIGN KEY ("suite_id") REFERENCES "test_suites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
