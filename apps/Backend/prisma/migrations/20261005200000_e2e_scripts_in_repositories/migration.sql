-- Scripts now live in the GitHub / Azure DevOps repository chosen for each run;
-- the database only keeps where they are.
ALTER TABLE "e2e_creations" ADD COLUMN "repo_provider" TEXT,
  ADD COLUMN "repo_id" TEXT,
  ADD COLUMN "repo_name" TEXT,
  ADD COLUMN "repo_branch" TEXT,
  ADD COLUMN "repo_path" TEXT;

ALTER TABLE "e2e_test_cases" ADD COLUMN "script_path" TEXT;
ALTER TABLE "e2e_test_cases" DROP COLUMN "script";
