CREATE TABLE "knowledge_relations" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "source_page_id" TEXT NOT NULL,
  "target_page_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "knowledge_relations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "knowledge_relations_owner_source_target_key"
  ON "knowledge_relations"("owner_id", "source_page_id", "target_page_id");
CREATE INDEX "knowledge_relations_owner_source_idx"
  ON "knowledge_relations"("owner_id", "source_page_id");
CREATE INDEX "knowledge_relations_owner_target_idx"
  ON "knowledge_relations"("owner_id", "target_page_id");
