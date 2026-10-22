CREATE TABLE "agent_workflows" (
    "workspace_id" TEXT NOT NULL,
    "definition" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "agent_workflows_pkey" PRIMARY KEY ("workspace_id")
);

ALTER TABLE "agent_workflows"
ADD CONSTRAINT "agent_workflows_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
