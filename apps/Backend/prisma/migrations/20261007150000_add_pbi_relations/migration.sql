CREATE TABLE "pbi_relations" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "target_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pbi_relations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pbi_relations_source_target_type_key" ON "pbi_relations"("source_id", "target_id", "type");
CREATE INDEX "pbi_relations_workspace_target_idx" ON "pbi_relations"("workspace_id", "target_id");
ALTER TABLE "pbi_relations" ADD CONSTRAINT "pbi_relations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pbi_relations" ADD CONSTRAINT "pbi_relations_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "pbi_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pbi_relations" ADD CONSTRAINT "pbi_relations_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "pbi_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
