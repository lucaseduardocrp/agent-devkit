CREATE TABLE "notification_contacts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_contacts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_contacts_workspace_user_channel_key" ON "notification_contacts"("workspace_id", "user_id", "channel");

CREATE INDEX "notification_contacts_workspace_idx" ON "notification_contacts"("workspace_id");

ALTER TABLE "notification_contacts" ADD CONSTRAINT "notification_contacts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
