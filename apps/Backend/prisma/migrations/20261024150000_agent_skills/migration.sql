-- Agents can use ADK Hub skills. Each entry keeps a copy of the SKILL.md that was attached, its
-- version and its sha256, so a run uses the reviewed text and the skill can be updated later.
ALTER TABLE "agents" ADD COLUMN "skills" JSONB NOT NULL DEFAULT '[]';
