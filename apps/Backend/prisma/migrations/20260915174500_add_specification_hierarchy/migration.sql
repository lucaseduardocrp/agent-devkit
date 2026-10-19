ALTER TABLE "specifications"
ADD COLUMN "parent_id" TEXT;

CREATE INDEX "specifications_workspace_parent_idx"
ON "specifications"("workspace_id", "parent_id");

ALTER TABLE "specifications"
ADD CONSTRAINT "specifications_parent_id_fkey"
FOREIGN KEY ("parent_id") REFERENCES "specifications"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
