-- Each run records the user its issue was assigned to when it started, so the inbox can be
-- private: a user sees only the runs executed while the issue was assigned to them.
ALTER TABLE "agent_runs" ADD COLUMN "assignee_user_id" TEXT;

-- Existing runs: the assignee at the run's start, rebuilt from the issue audit history. Issue
-- audit events keep only the fields that changed, so the latest change before the run gives
-- the value; with none, the first change after the run holds it in "before"; with no change at
-- all, the issue never changed assignee and its current value applies.
UPDATE "agent_runs" AS r
SET "assignee_user_id" = COALESCE(
  (
    SELECT jsonb_build_object('value', a."after" ->> 'assigneeUserId')
    FROM "audit_events" AS a
    WHERE a."entity_type" = 'issue'
      AND a."entity_id" = r."issue_id"
      AND a."after" ? 'assigneeUserId'
      AND a."occurred_at" <= r."created_at"
    ORDER BY a."sequence" DESC
    LIMIT 1
  ),
  (
    SELECT jsonb_build_object('value', a."before" ->> 'assigneeUserId')
    FROM "audit_events" AS a
    WHERE a."entity_type" = 'issue'
      AND a."entity_id" = r."issue_id"
      AND a."before" ? 'assigneeUserId'
      AND a."occurred_at" > r."created_at"
    ORDER BY a."sequence" ASC
    LIMIT 1
  ),
  (
    SELECT jsonb_build_object('value', i."assignee_user_id")
    FROM "issues" AS i
    WHERE i."id" = r."issue_id"
  )
) ->> 'value';

CREATE INDEX "agent_runs_workspace_assignee_idx"
ON "agent_runs" ("workspace_id", "assignee_user_id", "created_at");
