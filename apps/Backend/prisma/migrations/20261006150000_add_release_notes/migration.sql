CREATE TABLE "release_notes" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "version" TEXT NOT NULL DEFAULT '',
  "content" TEXT NOT NULL DEFAULT '',
  "agent_id" TEXT,
  "item_ids" JSONB NOT NULL DEFAULT '[]',
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "release_notes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "release_notes_workspace_updated_idx" ON "release_notes"("workspace_id", "updated_at");
ALTER TABLE "release_notes" ADD CONSTRAINT "release_notes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
