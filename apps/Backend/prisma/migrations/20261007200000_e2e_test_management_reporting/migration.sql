-- E2E runs can automate test cases of a test management platform (Azure Test Plans,
-- TestRail, Xray...) and publish their results there with per-step evidence.
ALTER TABLE "e2e_creations" ADD COLUMN "reporting" TEXT,
  ADD COLUMN "last_report" TEXT;

ALTER TABLE "e2e_test_cases" ADD COLUMN "external_case" TEXT,
  ADD COLUMN "step_results" JSONB NOT NULL DEFAULT '[]';
