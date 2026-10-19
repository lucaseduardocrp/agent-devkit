---
name: adk-specs
description: Use when the user wants to write, review, improve, export or publish a specification (spec, PRD, requirements document) in ADK, manage spec templates, or turn a Brain document into a spec.
---

# ADK Specs

Specs follow a **template**: ordered sections with guidance. Each spec section is identified by its
`templateSectionId`.

## Draft or improve a spec (host mode, no API key)

1. Find the spec with `spec_list { query }`. For a new spec, pick a template with `spec_list_templates`.
2. Call `spec_prepare_draft { request, specId? | templateId?, agentId? }`. It returns the section
   contract with guidance, the current content, the agent persona (if any) and related Brain sources.
3. Run a short discovery: ask the user objective questions about the gaps (actors, rules, errors,
   non-functional requirements, acceptance criteria). Do not invent dependencies or rules; record
   open questions instead.
4. Write each section in Markdown, distributing each topic into its matching section.
5. Show the draft, confirm, then save:
   - existing spec: `spec_update_sections { specId, title?, sections: [{ templateSectionId, content }] }`;
   - new spec: `spec_save { templateId, title, sections: [{ templateSectionId, title, content }] }`
     (add `parentId` for a child spec).

## From a Brain document

- Host mode: `brain_get_document`, then `spec_prepare_draft { request: "Spec for <title>", templateId }`,
  write the sections and `spec_save`.
- Server mode: `spec_generate_from_brain { pageId, source, title, agentId }`.

## Other actions

- For discovery chat without an API key, call `spec_prepare_chat { specId, content, agentId? }`,
  answer with your own model, then call
  `spec_save_chat_reply { specId, userMessage, assistantMessage }`.
  Apply proposed section changes with `spec_update_sections` only after the user agrees.
- `spec_chat` explicitly uses the workspace LLM and returns an optional `proposal`.
  `spec_clear_chat` wipes the history (confirm first).
- `spec_export_markdown` returns the spec as a Markdown document.
- `spec_publish_to_brain` makes the spec searchable in the Brain.
- Test cases from a spec: skill `adk-test-plans` with `sourceType: "spec"`.
- Templates (ADMIN only): `spec_save_template { templateId?, name, sections: [{ id, title, guidance, required }] }`
  and `spec_delete_template`.
