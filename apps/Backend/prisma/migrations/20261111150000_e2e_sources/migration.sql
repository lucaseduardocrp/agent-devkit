-- The Source of a workspace: script and pages of its latest Source exploration (one per workspace).
CREATE TABLE "e2e_sources" (
    "workspace_id" TEXT NOT NULL,
    "creation_id" TEXT NOT NULL,
    "start_url" TEXT NOT NULL,
    "signed_in_ms" INTEGER,
    "script" JSONB NOT NULL DEFAULT '[]',
    "pages" JSONB NOT NULL DEFAULT '[]',
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "e2e_sources_pkey" PRIMARY KEY ("workspace_id")
);
