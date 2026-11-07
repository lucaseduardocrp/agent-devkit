CREATE TABLE "notification_rules" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "event" TEXT NOT NULL,
    "channels" JSONB NOT NULL DEFAULT '[]',
    "recipients" JSONB NOT NULL DEFAULT '{}',
    "subject" TEXT NOT NULL DEFAULT '',
    "message" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notification_rules_event_idx" ON "notification_rules"("workspace_id", "event", "enabled");

ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
