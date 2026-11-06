ALTER TABLE "issues" ADD COLUMN "type" TEXT NOT NULL DEFAULT '';

CREATE TABLE "work_item_type_settings" (
  "workspace_id" TEXT NOT NULL,
  "types" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "work_item_type_settings_pkey" PRIMARY KEY ("workspace_id")
);
