CREATE TABLE "audit_events" (
 "id" TEXT PRIMARY KEY, "sequence" SERIAL NOT NULL, "workspace_id" TEXT NOT NULL, "entity_type" TEXT NOT NULL,
 "entity_id" TEXT NOT NULL, "action" TEXT NOT NULL, "actor_id" TEXT,
 "request_id" TEXT NOT NULL, "operation" TEXT NOT NULL,
 "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "before" JSONB NOT NULL, "after" JSONB NOT NULL
);
CREATE UNIQUE INDEX "audit_events_sequence_key" ON "audit_events"("sequence");
CREATE INDEX "audit_events_workspace_type_sequence_idx" ON "audit_events"("workspace_id", "entity_type", "sequence");
CREATE INDEX "audit_events_entity_sequence_idx" ON "audit_events"("workspace_id", "entity_type", "entity_id", "sequence");
