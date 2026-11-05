CREATE TABLE "design_settings" (
  "workspace_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "repository_id" TEXT NOT NULL,
  "repository_name" TEXT NOT NULL,
  "branch" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "design_settings_pkey" PRIMARY KEY ("workspace_id")
);
