ALTER TABLE "issues"
ADD COLUMN "attachments" JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "pbi_items"
ADD COLUMN "attachments" JSONB NOT NULL DEFAULT '[]'::jsonb;
