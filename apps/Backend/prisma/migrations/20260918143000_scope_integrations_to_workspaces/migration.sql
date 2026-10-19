-- Integrations are workspace-scoped. Since workspaces were introduced, the
-- application has passed a workspace id as owner_id, while the original
-- constraint still pointed to users.id.
ALTER TABLE "integration_configs"
DROP CONSTRAINT IF EXISTS "integration_configs_owner_id_fkey";

-- Preserve legacy user-scoped integrations. A user that already owns a
-- workspace is mapped to their oldest workspace. For the unlikely legacy case
-- where no workspace exists, create a personal workspace first.
INSERT INTO "workspaces" (
    "id",
    "name",
    "slug",
    "owner_id",
    "created_at",
    "updated_at"
)
SELECT
    user_record."id",
    user_record."name" || '''s Workspace',
    'legacy-' || user_record."id",
    user_record."id",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "users" AS user_record
WHERE EXISTS (
    SELECT 1
    FROM "integration_configs" AS integration
    WHERE integration."owner_id" = user_record."id"
)
AND NOT EXISTS (
    SELECT 1
    FROM "workspaces" AS workspace
    WHERE workspace."owner_id" = user_record."id"
);

INSERT INTO "workspace_members" (
    "id",
    "workspace_id",
    "user_id",
    "role",
    "permissions",
    "created_at",
    "updated_at"
)
SELECT
    workspace."id",
    workspace."id",
    workspace."owner_id",
    'ADMIN'::"WorkspaceRole",
    '{}'::JSONB,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "workspaces" AS workspace
WHERE workspace."id" = workspace."owner_id"
  AND workspace."slug" = 'legacy-' || workspace."owner_id"
  AND NOT EXISTS (
      SELECT 1
      FROM "workspace_members" AS member
      WHERE member."workspace_id" = workspace."id"
        AND member."user_id" = workspace."owner_id"
  );

WITH legacy_owner_mapping AS (
    SELECT
        user_record."id" AS "user_id",
        (
            SELECT workspace."id"
            FROM "workspaces" AS workspace
            WHERE workspace."owner_id" = user_record."id"
            ORDER BY workspace."created_at", workspace."id"
            LIMIT 1
        ) AS "workspace_id"
    FROM "users" AS user_record
)
UPDATE "integration_configs" AS integration
SET "owner_id" = mapping."workspace_id"
FROM legacy_owner_mapping AS mapping
WHERE integration."owner_id" = mapping."user_id"
  AND mapping."workspace_id" IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM "workspaces" AS current_workspace
      WHERE current_workspace."id" = integration."owner_id"
  );

ALTER TABLE "integration_configs"
ADD CONSTRAINT "integration_configs_owner_id_fkey"
FOREIGN KEY ("owner_id") REFERENCES "workspaces"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
