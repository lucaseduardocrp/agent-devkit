-- Runs that plan and write their tests from the Brain instead of an uploaded PRD.
ALTER TABLE "e2e_creations" ADD COLUMN "use_brain" BOOLEAN NOT NULL DEFAULT false;
