ALTER TABLE "agents" ADD COLUMN "parent_agent_id" TEXT;

CREATE INDEX "agents_workspace_parent_idx" ON "agents"("workspace_id", "parent_agent_id");
