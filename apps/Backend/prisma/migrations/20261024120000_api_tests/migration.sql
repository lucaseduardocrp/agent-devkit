-- Integration tests (collections, environments), overload tests (load scenarios) and their runs.
-- api_runs is also the work queue of the workers (remote) and of devkit runner (local).

-- CreateTable
CREATE TABLE "api_collections" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "definition" JSONB NOT NULL,
    "source" JSONB NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_environments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "variables" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_environments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "load_scenarios" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "load_scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "scenario_id" TEXT,
    "environment_id" TEXT,
    "item_ids" JSONB NOT NULL DEFAULT '[]',
    "name" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "requested_by" TEXT NOT NULL,
    "claimed_by" TEXT,
    "claim_label" TEXT,
    "heartbeat_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "payload" TEXT,
    "result" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "api_collections_workspace_idx" ON "api_collections"("workspace_id");

-- CreateIndex
CREATE INDEX "api_environments_workspace_idx" ON "api_environments"("workspace_id");

-- CreateIndex
CREATE INDEX "load_scenarios_workspace_idx" ON "load_scenarios"("workspace_id");

-- CreateIndex
CREATE INDEX "api_runs_claim_idx" ON "api_runs"("status", "target", "created_at");

-- CreateIndex
CREATE INDEX "api_runs_workspace_idx" ON "api_runs"("workspace_id", "created_at");

-- AddForeignKey
ALTER TABLE "api_collections" ADD CONSTRAINT "api_collections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_environments" ADD CONSTRAINT "api_environments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_scenarios" ADD CONSTRAINT "load_scenarios_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_scenarios" ADD CONSTRAINT "load_scenarios_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "api_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_runs" ADD CONSTRAINT "api_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

