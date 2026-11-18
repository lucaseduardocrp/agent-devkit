-- Scripts of finished Site Explorations (actions and pages), kept in the database for reuse.
CREATE TABLE "e2e_exploration_scripts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "creation_id" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "signed_in_ms" INTEGER,
    "script" JSONB NOT NULL DEFAULT '[]',
    "pages" JSONB NOT NULL DEFAULT '[]',
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "e2e_exploration_scripts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "e2e_exploration_scripts_workspace_created_idx" ON "e2e_exploration_scripts"("workspace_id", "created_at");
CREATE INDEX "e2e_exploration_scripts_creation_created_idx" ON "e2e_exploration_scripts"("creation_id", "created_at");

ALTER TABLE "e2e_exploration_scripts" ADD CONSTRAINT "e2e_exploration_scripts_creation_id_fkey" FOREIGN KEY ("creation_id") REFERENCES "e2e_creations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
