CREATE TABLE "llm_usage_events" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL,
  "actor_id" TEXT,
  "source" TEXT NOT NULL DEFAULT 'mcp',
  "tool" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "input_tokens" INTEGER NOT NULL,
  "output_tokens" INTEGER NOT NULL,
  "estimated" BOOLEAN NOT NULL DEFAULT true,
  "cost_micros" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "llm_usage_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "llm_usage_events_workspace_created_idx" ON "llm_usage_events"("workspace_id", "created_at");
