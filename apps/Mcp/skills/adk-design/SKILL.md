---
name: adk-design
description: Use when the user wants an HTML/CSS/JS prototype, a UI mockup or a Design System in ADK Design, or wants to iterate on, list or delete prototypes stored in the GitHub or Azure repository.
---

# ADK Design

Prototypes and Design Systems are stored in a Git repository (`provider`: `github` or `azure`).
Start with `design_list_providers`. If it is empty, the workspace must configure a GitHub Projects
or Azure DevOps integration with a repository (skill `adk-workspace-admin`).

## Create a prototype (host mode, no API key)

1. Optional: choose a Design System with `design_list_systems { provider }`.
2. Call `design_prepare { provider, request, designSystemId? }` to get the rules and the Design
   System content.
3. Write the files yourself: always `index.html`, `styles.css` and `script.js` (optional `.jsx`),
   responsive, accessible, without external dependencies, with relative file names only.
4. Save with `design_save_new_project { provider, title, prompt, files, summary }`.

## Change a prototype (host mode)

1. Call `design_prepare { provider, projectId, request }` to get the current files and the recent
   conversation.
2. Edit and send the **complete** file set with `design_update_files { provider, projectId, files }`.

## Design Systems

Author one self-contained HTML file (CSS inside `<style>`) with color, typography and spacing tokens
plus component examples, then call `design_save_system { provider, name, content, systemId? }`.

## Server mode

`design_create_project`, `design_chat` and `design_generate_system` use an agent with the workspace
LLM. They accept up to four reference images as base64.

## Other actions

`design_list_projects`, `design_get_project { includeContent }`, `design_delete_project` and
`design_delete_system` (confirm deletions with the user).
