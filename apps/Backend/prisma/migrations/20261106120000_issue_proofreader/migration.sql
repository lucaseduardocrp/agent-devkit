-- Reviewer of an issue; the issue is shown in their inbox as well as the assignee inbox.
ALTER TABLE "issues" ADD COLUMN "proofreader_user_id" TEXT;
