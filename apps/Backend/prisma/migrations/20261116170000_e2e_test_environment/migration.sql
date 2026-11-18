-- A test can run with its own saved environment (account, URL and variables); NULL inherits the run's.
ALTER TABLE "e2e_test_cases" ADD COLUMN "environment_id" TEXT;
