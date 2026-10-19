CREATE TABLE "knowledge_chunks" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_chunks_chunk_index_nonnegative" CHECK ("chunk_index" >= 0)
);

CREATE INDEX "knowledge_chunks_owner_idx" ON "knowledge_chunks"("owner_id");

CREATE INDEX "knowledge_chunks_owner_source_page_idx"
    ON "knowledge_chunks"("owner_id", "source", "page_id");

CREATE UNIQUE INDEX "knowledge_chunks_owner_source_page_chunk_key"
    ON "knowledge_chunks"("owner_id", "source", "page_id", "chunk_index");
