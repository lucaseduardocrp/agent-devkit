ALTER TABLE "board_columns" ADD COLUMN IF NOT EXISTS "is_fixed" BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
DECLARE
  workspace RECORD;
  backlog_id TEXT;
BEGIN
  FOR workspace IN SELECT DISTINCT "workspace_id" FROM "board_columns" LOOP
    SELECT "id" INTO backlog_id
    FROM "board_columns"
    WHERE "workspace_id" = workspace."workspace_id" AND "name" = 'Backlog'
    ORDER BY "position", "created_at"
    LIMIT 1;

    IF backlog_id IS NULL THEN
      backlog_id := gen_random_uuid()::text;
      INSERT INTO "board_columns" ("id", "workspace_id", "name", "is_fixed", "position", "created_at", "updated_at")
      VALUES (backlog_id, workspace."workspace_id", 'Backlog', TRUE, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      UPDATE "board_columns"
      SET "position" = "position" + 1
      WHERE "workspace_id" = workspace."workspace_id" AND "id" <> backlog_id;
    ELSE
      UPDATE "board_columns" SET "name" = 'Backlog', "is_fixed" = TRUE WHERE "id" = backlog_id;
    END IF;
  END LOOP;
END $$;
