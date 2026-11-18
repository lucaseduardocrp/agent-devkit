-- Messaging integrations (Telegram): the bot of a workspace and the chats paired with it.
ALTER TYPE "IntegrationCategory" ADD VALUE 'MESSAGING';

-- CreateTable
CREATE TABLE "messaging_chats" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "linked_by" TEXT NOT NULL,
    "agent_id" TEXT,
    "notifications" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messaging_chats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "messaging_chats_workspace_provider_chat_key" ON "messaging_chats"("workspace_id", "provider", "chat_id");

-- AddForeignKey
ALTER TABLE "messaging_chats" ADD CONSTRAINT "messaging_chats_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
