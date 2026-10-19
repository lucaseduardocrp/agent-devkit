CREATE TABLE "board_columns" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "board_columns_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "board_tasks" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "column_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
  "assignee_id" TEXT,
  "position" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "board_tasks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "board_columns_workspace_position_idx" ON "board_columns"("workspace_id", "position");
CREATE INDEX "board_tasks_workspace_column_position_idx" ON "board_tasks"("workspace_id", "column_id", "position");
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_tasks" ADD CONSTRAINT "board_tasks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_tasks" ADD CONSTRAINT "board_tasks_column_id_fkey" FOREIGN KEY ("column_id") REFERENCES "board_columns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_tasks" ADD CONSTRAINT "board_tasks_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
