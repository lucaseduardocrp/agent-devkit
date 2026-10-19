-- Permission groups grant module access (view, edit, delete) to workspace members.
CREATE TABLE "permission_groups" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "modules" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "permission_groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "permission_groups_workspace_name_key" ON "permission_groups"("workspace_id", "name");
ALTER TABLE "permission_groups" ADD CONSTRAINT "permission_groups_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "permission_group_members" (
  "group_id" TEXT NOT NULL,
  "member_id" TEXT NOT NULL,
  CONSTRAINT "permission_group_members_pkey" PRIMARY KEY ("group_id", "member_id")
);
CREATE INDEX "permission_group_members_member_id_idx" ON "permission_group_members"("member_id");
ALTER TABLE "permission_group_members" ADD CONSTRAINT "permission_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "permission_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "permission_group_members" ADD CONSTRAINT "permission_group_members_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "workspace_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing members keep the access their role granted: each workspace gets groups that
-- mirror the former MEMBER, INTEGRATOR and VIEWER defaults. ADMIN members need no group.
INSERT INTO "permission_groups" ("id", "workspace_id", "name", "description", "modules", "updated_at")
SELECT gen_random_uuid()::text, w."id", 'Editores',
       'Visualizar, criar/editar e excluir conteúdo; integrações somente leitura.',
       '{"issues":"delete","pbis":"delete","agents":"delete","brain":"delete","design":"delete","specs":"delete","releaseNotes":"delete","testplans":"delete","e2e":"delete","integrations":"view"}'::jsonb,
       CURRENT_TIMESTAMP
FROM "workspaces" w;

INSERT INTO "permission_groups" ("id", "workspace_id", "name", "description", "modules", "updated_at")
SELECT gen_random_uuid()::text, w."id", 'Leitores',
       'Somente visualização; sem acesso às integrações.',
       '{"issues":"view","pbis":"view","agents":"view","brain":"view","design":"view","specs":"view","releaseNotes":"view","testplans":"view","e2e":"view"}'::jsonb,
       CURRENT_TIMESTAMP
FROM "workspaces" w;

INSERT INTO "permission_groups" ("id", "workspace_id", "name", "description", "modules", "updated_at")
SELECT gen_random_uuid()::text, w."id", 'Integradores',
       'Acesso completo, incluindo a gestão de integrações.',
       '{"issues":"delete","pbis":"delete","agents":"delete","brain":"delete","design":"delete","specs":"delete","releaseNotes":"delete","testplans":"delete","e2e":"delete","integrations":"delete"}'::jsonb,
       CURRENT_TIMESTAMP
FROM "workspaces" w
WHERE EXISTS (
  SELECT 1 FROM "workspace_members" m
  WHERE m."workspace_id" = w."id"
    AND (m."role" = 'INTEGRATOR'
      OR (m."role" = 'MEMBER' AND m."permissions"->>'canManageIntegrations' = 'true'))
);

INSERT INTO "permission_group_members" ("group_id", "member_id")
SELECT g."id", m."id"
FROM "workspace_members" m
JOIN "permission_groups" g ON g."workspace_id" = m."workspace_id"
WHERE (g."name" = 'Leitores' AND m."role" = 'VIEWER')
   OR (g."name" = 'Integradores'
       AND (m."role" = 'INTEGRATOR'
         OR (m."role" = 'MEMBER' AND m."permissions"->>'canManageIntegrations' = 'true')))
   OR (g."name" = 'Editores'
       AND m."role" = 'MEMBER'
       AND COALESCE(m."permissions"->>'canManageIntegrations', 'false') <> 'true');
