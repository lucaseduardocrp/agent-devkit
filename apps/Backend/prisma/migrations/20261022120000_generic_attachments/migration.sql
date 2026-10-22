ALTER TABLE "specifications"
ADD COLUMN "attachments" JSONB NOT NULL DEFAULT '[]'::jsonb;
