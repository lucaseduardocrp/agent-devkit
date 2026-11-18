ALTER TABLE "e2e_test_cases"
  ADD COLUMN "success_criteria" TEXT,
  ADD COLUMN "result_source" TEXT NOT NULL DEFAULT 'run',
  ADD COLUMN "result_note" TEXT;
