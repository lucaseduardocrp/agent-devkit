ALTER TABLE "audit_events"
  ADD COLUMN "actor_name" TEXT,
  ADD COLUMN "actor_email" TEXT;

-- Legacy events without an author can be safely assigned only when the
-- workspace has a single member. Multi-member workspaces remain unassigned.
UPDATE "audit_events" AS event
SET "actor_id" = workspace."owner_id"
FROM "workspaces" AS workspace
WHERE event."workspace_id" = workspace."id"
  AND event."actor_id" IS NULL
  AND 1 = (
    SELECT COUNT(*)
    FROM "workspace_members" AS member
    WHERE member."workspace_id" = workspace."id"
  );

UPDATE "audit_events" AS event
SET
  "actor_name" = user_record."name",
  "actor_email" = user_record."email"
FROM "users" AS user_record
WHERE event."actor_id" = user_record."id"
  AND event."actor_name" IS NULL;
