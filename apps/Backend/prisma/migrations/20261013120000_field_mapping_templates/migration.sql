CREATE TABLE "field_mapping_templates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT '',
    "item_type" TEXT NOT NULL DEFAULT '',
    "rules" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "field_mapping_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "field_mappings_destination_idx" ON "field_mapping_templates"("workspace_id", "provider_id", "entity_type");
ALTER TABLE "field_mapping_templates" ADD CONSTRAINT "field_mapping_templates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
