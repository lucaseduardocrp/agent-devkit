ALTER TABLE "workspaces" ADD COLUMN "monthly_budget_micros" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "issues" ADD COLUMN "active_run_id" TEXT;

CREATE TABLE "agent_runs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL,
  "issue_id" TEXT NOT NULL,
  "agent_id" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "mode" TEXT NOT NULL DEFAULT 'server',
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "prompt" TEXT NOT NULL,
  "output" TEXT,
  "error" TEXT,
  "provider" TEXT,
  "model" TEXT,
  "input_tokens" INTEGER,
  "output_tokens" INTEGER,
  "cost_micros" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  CONSTRAINT "agent_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "agent_runs_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "agent_runs_workspace_created_idx" ON "agent_runs"("workspace_id", "created_at");
CREATE INDEX "agent_runs_issue_created_idx" ON "agent_runs"("issue_id", "created_at");

CREATE TABLE "cost_rates" (
  "workspace_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "input_usd_per_million" DOUBLE PRECISION NOT NULL,
  "output_usd_per_million" DOUBLE PRECISION NOT NULL,
  CONSTRAINT "cost_rates_pkey" PRIMARY KEY ("workspace_id", "provider", "model"),
  CONSTRAINT "cost_rates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
