---
name: adk-workspace-admin
description: Use when the user wants to manage ADK workspaces, members, roles and permissions, configure or test integrations (Azure DevOps Wiki, GitHub Projects, Wiki.js, LLM providers), or review the audit history.
---

# ADK workspace administration

## Workspaces

- `workspaces_list`, `workspaces_get`, `workspaces_select`, `workspaces_create { name }`.
- `workspaces_delete` removes the workspace and all of its content. Confirm the exact workspace name
  with the user before calling it.

## Members and permissions

- `workspaces_list_members`, `workspaces_add_member { email, role, permissions? }` (the person must
  already have an ADK account), `workspaces_update_member`, `workspaces_remove_member`.
- Roles: ADMIN (everything), MEMBER (content), INTEGRATOR (integrations), VIEWER (read-only).
- `permissions.modules.<brain|connect|testplans|pipelines|settings>` is `read`, `write` or `none`.
- The last ADMIN of a workspace cannot be demoted.

## Integrations

- `integrations_list` (secrets are masked), `integrations_test`, `integrations_save`,
  `integrations_delete`.
- Categories: `KNOWLEDGE` (azure_devops_wiki, github_projects, wiki_js), `PROJECT_MANAGEMENT`, and
  `LLM` (openai, anthropic or claude, gemini, groq, ollama).
- Secrets typed in chat reach the model provider, so recommend entering API keys in the ADK web app.
  Host-mode tools do not need any LLM integration.
- `integrations_list_azure_members` lists Azure DevOps members for test assignment.

## Audit

`audit_history { entityType: document | specification | template | testplan, entityId?, page? }`.
