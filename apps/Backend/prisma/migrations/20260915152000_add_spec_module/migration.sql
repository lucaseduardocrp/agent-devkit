CREATE TABLE "spec_templates" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sections" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "spec_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "specifications" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "template_id" TEXT,
  "agent_id" TEXT,
  "title" TEXT NOT NULL,
  "sections" JSONB NOT NULL,
  "messages" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "specifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "spec_templates_workspace_updated_idx" ON "spec_templates"("workspace_id", "updated_at");
CREATE INDEX "specifications_workspace_updated_idx" ON "specifications"("workspace_id", "updated_at");
ALTER TABLE "spec_templates" ADD CONSTRAINT "spec_templates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "specifications" ADD CONSTRAINT "specifications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "specifications" ADD CONSTRAINT "specifications_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "spec_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
