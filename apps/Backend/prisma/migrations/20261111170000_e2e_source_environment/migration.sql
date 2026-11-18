-- The Source explores a saved environment through a hidden run of the workspace.
ALTER TABLE "e2e_creations" ADD COLUMN "internal" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "e2e_sources" ADD COLUMN "environment_id" TEXT;
