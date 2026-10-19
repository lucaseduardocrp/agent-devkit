-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM (
    'ADMIN',
    'MEMBER',
    'INTEGRATOR',
    'VIEWER'
);

-- CreateEnum
CREATE TYPE "AgentRole" AS ENUM (
    'QA',
    'DOCUMENTATION',
    'REFACTOR',
    'CUSTOM'
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'MEMBER',
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "role" "AgentRole" NOT NULL DEFAULT 'CUSTOM',
    "instructions" TEXT NOT NULL,
    "model" TEXT,
    "temperature" DOUBLE PRECISION DEFAULT 0.2,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "workspaces_slug_key"
ON "workspaces"("slug");

CREATE INDEX "workspaces_owner_id_idx"
ON "workspaces"("owner_id");

CREATE UNIQUE INDEX "workspace_members_workspace_user_key"
ON "workspace_members"("workspace_id", "user_id");

CREATE INDEX "workspace_members_workspace_id_idx"
ON "workspace_members"("workspace_id");

CREATE INDEX "workspace_members_user_id_idx"
ON "workspace_members"("user_id");

CREATE UNIQUE INDEX "agents_workspace_slug_key"
ON "agents"("workspace_id", "slug");

CREATE INDEX "agents_workspace_id_idx"
ON "agents"("workspace_id");

-- Foreign Keys
ALTER TABLE "workspaces"
ADD CONSTRAINT "workspaces_owner_id_fkey"
FOREIGN KEY ("owner_id")
REFERENCES "users"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "workspace_members"
ADD CONSTRAINT "workspace_members_workspace_id_fkey"
FOREIGN KEY ("workspace_id")
REFERENCES "workspaces"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "workspace_members"
ADD CONSTRAINT "workspace_members_user_id_fkey"
FOREIGN KEY ("user_id")
REFERENCES "users"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "agents"
ADD CONSTRAINT "agents_workspace_id_fkey"
FOREIGN KEY ("workspace_id")
REFERENCES "workspaces"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;