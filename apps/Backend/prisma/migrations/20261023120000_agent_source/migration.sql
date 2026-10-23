-- Agents installed from the ADK Hub remember where they came from (hub agent or plugin subagent,
-- version and revision) so they can be updated later. Agents made in the workspace keep NULL.
ALTER TABLE "agents" ADD COLUMN "source" JSONB;
