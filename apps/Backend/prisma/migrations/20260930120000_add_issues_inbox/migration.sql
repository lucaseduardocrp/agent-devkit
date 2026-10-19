CREATE TABLE "issue_counters" (
  "workspace_id" TEXT NOT NULL PRIMARY KEY,
  "next_number" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "issue_counters_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "issues" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL,
  "number" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'todo',
  "priority" TEXT NOT NULL DEFAULT 'medium',
  "assignee_agent_id" TEXT,
  "assignee_user_id" TEXT,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "issues_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "issues_workspace_number_key" ON "issues"("workspace_id", "number");
CREATE INDEX "issues_workspace_updated_idx" ON "issues"("workspace_id", "updated_at");

CREATE TABLE "issue_comments" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "issue_id" TEXT NOT NULL,
  "author_id" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "issue_comments_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "issue_comments_issue_created_idx" ON "issue_comments"("issue_id", "created_at");

CREATE TABLE "issue_inbox" (
  "issue_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "read_at" TIMESTAMP(3),
  "archived_at" TIMESTAMP(3),
  CONSTRAINT "issue_inbox_pkey" PRIMARY KEY ("issue_id", "user_id"),
  CONSTRAINT "issue_inbox_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
