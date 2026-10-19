---
name: adk-test-plans
description: Use when the user wants test cases, a test plan, QA coverage or an Azure DevOps test CSV from a requirement, user story, bug, Brain document or ADK spec, wants to bring Test Plans, suites or cases that already exist in Azure DevOps, TestRail or Xray into ADK, or wants to organize saved Test Plans and suites in ADK.
---

# ADK Test Plans

## Generate a Test Plan (host mode, no API key)

1. Gather the source:
   - free text from the user; or
   - a Brain page (`brain_get_document`), then use `sourceType: "brain"` and `sourceId: <pageId>`; or
   - a spec (`spec_export_markdown`), then use `sourceType: "spec"` and `sourceId: <specId>`.
2. Optional: pick a QA agent with `agents_list { role: "QA" }` and pass its `agentId`.
3. Call `testplans_prepare { prompt, criteria?, agentId?, title? }`.
4. Follow the returned `instruction` **exactly**. It is the same contract ADK's own model uses:
   - a JSON array of `{ title, description, steps: [{ order, action, expectedResult }] }`;
   - `description` is an object, never free text: `{ useCase, preconditions, inputData,
     expectedResult, postconditions, flow }`. Write plain text in each field (no HTML, no `##`).
     ADK renders it into the team's default template: bold `## Caso de uso`, `## Pré-condições`,
     `## Dados de entrada`, `## Resultado esperado`, `## Pós-condições` and a `## Fluxo do Processo`
     box diagram. `flow` has 2-8 short nodes in execution order, `{ "step": "Acessar Painel" }` or
     `{ "decision": "Possui Subtipo?", "yes": "Exibir Subtipo", "no": "Exibir \"-\"" }`;
   - every value written in `outputLanguage`;
   - one test case per main flow, alternative, boundary, validation and error path the source supports;
   - atomic, executable actions that start with an imperative verb, one observable result per step;
   - never copy the requirement into a step and never invent screens or rules.
5. Show the user a compact summary (case titles and step counts). Ask which suite to use when it
   matters (`testplans_list_suites`; the default suite is "Test").
6. Save with `testplans_save { title, plans, sourceType?, sourceId?, suiteId? }`.
   Pass `includeCsv: true` only if the user wants the Azure DevOps CSV now.

For CSV without saving a Test Plan, write the cases after `testplans_prepare` and call
`testplans_render_csv { plans, platformProvider?, areaPath?, assignedTo? }`.

## Server mode

`testplans_generate` uses the workspace LLM. Without an LLM integration ADK silently falls back to a
basic deterministic plan, so prefer host mode.

## Import existing Test Plans (Azure DevOps, TestRail, Xray)

When the cases already exist on a test management platform, import them instead of writing them
again:

1. `e2e_test_management_providers` shows the configured platforms and how they name their levels.
   Browse with `e2e_list_remote_plans { provider }`, `e2e_list_remote_suites { provider, planId }`
   and `e2e_list_remote_cases { provider, planId, suiteId? }`.
2. `testplans_import_cases { providerId, planId }` imports the whole plan: the remote suite
   hierarchy becomes local suites (under one named after the plan) and each remote suite becomes
   one Test Plan. Narrow it with `suiteId` (plus `includeChildSuites: true` for its nested suites),
   `caseIds`, or put it under an existing suite with `localSuiteId`.
3. Every case keeps its steps, remote id and link, and all of the platform's fields (standard and
   custom) in `metadata.customFields[provider]` with display names in
   `metadata.customFieldLabels[provider]`; read them with `testplans_get`.
4. Importing the same plan again refreshes those Test Plans in place and keeps each case's local
   id and history; a partial import (`caseIds`) keeps the other cases.

To automate imported or saved cases, call `e2e_create` with `savedCases { suiteId | planId,
caseIds? }` (see the adk-e2e skill).

## Maintain plans

- `testplans_list`, `testplans_get`, `testplans_update { plans }` (full replacement of the cases),
  `testplans_update { suiteId }` to move a plan, `testplans_delete` (confirm first).
- Suites: `testplans_create_suite { name, parentId? }`, `testplans_update_suite`,
  `testplans_delete_suite` (empty suites only).
- History: `audit_history { entityType: "testplan", entityId }`.

## Publish a saved suite

1. Choose the local suite with `testplans_list_suites` and check that it contains the intended test cases.
2. Call `testplans_list_publish_providers` and choose a configured `providerId`.
3. To create a new remote Test Plan, call `testplans_push_suite { suiteId, providerId }` after the user requests publication.
4. To add cases to an existing remote suite, call `testplans_list_remote_plans { providerId }`, then `testplans_list_remote_suites { providerId, remotePlanId }`. Select a static or requirement-based suite and call `testplans_push_suite { suiteId, providerId, remotePlanId, remoteSuiteId }`. Cases in the local suite and its children are added directly to the selected suite. Query-based suites are read-only.
5. To create a child suite under an existing static suite, use `testplans_push_suite { suiteId, providerId, remotePlanId, remoteParentSuiteId }`.

## Quality checklist before saving

- [ ] Every step has both `action` and `expectedResult`.
- [ ] No vague steps such as "execute the flow" or "works as expected".
- [ ] The language matches `outputLanguage`.
- [ ] Coverage includes the negative and boundary cases the source supports.
