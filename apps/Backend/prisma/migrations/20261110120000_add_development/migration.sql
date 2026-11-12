CREATE TABLE "development_changes" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "development_changes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "development_changes_workspace_slug_key" ON "development_changes"("workspace_id", "slug");

CREATE INDEX "development_changes_workspace_updated_idx" ON "development_changes"("workspace_id", "updated_at");

ALTER TABLE "development_changes" ADD CONSTRAINT "development_changes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "development_sessions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "change_id" TEXT,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "development_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "development_sessions_workspace_updated_idx" ON "development_sessions"("workspace_id", "updated_at");

CREATE INDEX "development_sessions_workspace_status_idx" ON "development_sessions"("workspace_id", "status");

ALTER TABLE "development_sessions" ADD CONSTRAINT "development_sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing permission groups get the same access to Development that they have to Specs, so the
-- module does not appear locked for members who already write specifications.
UPDATE "permission_groups"
SET "modules" = "modules" || jsonb_build_object('development', "modules"->>'specs')
WHERE "modules" ? 'specs' AND NOT ("modules" ? 'development');
