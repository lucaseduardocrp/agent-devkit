CREATE TABLE "pbi_items" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "parent_id" TEXT,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'backlog',
  "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "source_data" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pbi_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pbi_items_workspace_parent_position_idx" ON "pbi_items"("workspace_id", "parent_id", "position");
ALTER TABLE "pbi_items" ADD CONSTRAINT "pbi_items_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pbi_items" ADD CONSTRAINT "pbi_items_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "pbi_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "pbi_external_links" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "item_id" TEXT NOT NULL,
  "provider_id" TEXT NOT NULL,
  "external_id" TEXT NOT NULL,
  "external_url" TEXT,
  "board_id" TEXT,
  "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pbi_external_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pbi_links_workspace_provider_external_key" ON "pbi_external_links"("workspace_id", "provider_id", "external_id");
CREATE UNIQUE INDEX "pbi_links_item_provider_board_key" ON "pbi_external_links"("item_id", "provider_id", "board_id");
CREATE INDEX "pbi_links_workspace_provider_idx" ON "pbi_external_links"("workspace_id", "provider_id");
ALTER TABLE "pbi_external_links" ADD CONSTRAINT "pbi_external_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pbi_external_links" ADD CONSTRAINT "pbi_external_links_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "pbi_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "issues" ADD COLUMN "pbi_item_id" TEXT;
CREATE INDEX "issues_workspace_pbi_idx" ON "issues"("workspace_id", "pbi_item_id");
ALTER TABLE "issues" ADD CONSTRAINT "issues_pbi_item_id_fkey" FOREIGN KEY ("pbi_item_id") REFERENCES "pbi_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
