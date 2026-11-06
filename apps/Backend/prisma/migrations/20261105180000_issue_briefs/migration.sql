CREATE TABLE "issue_briefs" (
  "issue_id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "data" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "issue_briefs_pkey" PRIMARY KEY ("issue_id")
);

CREATE INDEX "issue_briefs_workspace_idx" ON "issue_briefs"("workspace_id");

ALTER TABLE "issue_briefs" ADD CONSTRAINT "issue_briefs_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
