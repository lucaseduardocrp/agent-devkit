-- Integration tests: credentials become personal. Each member keeps their own secret variables,
-- auth credentials, proxy and certificate secrets, and runtime state; the shared collections and
-- environments keep only `{{variable}}` references. Values stored in the shared documents before
-- this change are moved by the API on first access (ApiTestService legacy migration).

-- AlterTable
ALTER TABLE "api_environments" ADD COLUMN "created_by" TEXT;

-- CreateTable
CREATE TABLE "api_personal_values" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scope_id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_personal_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_personal_values_key" ON "api_personal_values"("workspace_id", "user_id", "scope", "scope_id", "ref");

-- CreateIndex
CREATE INDEX "api_personal_values_scope_idx" ON "api_personal_values"("scope", "scope_id");

-- AddForeignKey
ALTER TABLE "api_personal_values" ADD CONSTRAINT "api_personal_values_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_personal_values" ADD CONSTRAINT "api_personal_values_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
