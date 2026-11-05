-- Issues with agent runs are soft deleted: they disappear from lists and the inbox, while their
-- runs keep the execution and cost history.

-- AlterTable
ALTER TABLE "issues" ADD COLUMN "deleted_at" TIMESTAMP(3);
