---
name: frontend-feature
description: "Use when building or changing React frontend features, routes, API clients, forms, dashboards, editors, or interactive views."
user-invocable: true
---

# Frontend Feature

## Objective

Build interfaces that consume typed contracts and handle loading, empty, error, conflict, and permission states.

## Workflow

1. Describe the user journey and states.
2. Confirm endpoint, DTO, error, and permission contracts.
3. Create or update the API client and state layer.
4. Separate server, form, and visual state.
5. Implement routes and components.
6. Add keyboard, focus, responsive, and accessibility behavior.
7. Handle retry, cancellation, and stale data.
8. Run component tests, typecheck, lint, and build.

## Guardrails

- never use the client as the only security boundary;
- do not use local storage as the server source of truth;
- keep fetch logic out of presentational components;
- keep visual dimensions stable;
- avoid interaction complexity without user value.

## Output

User flow, changed files, contract assumptions, states covered, tests run, and unresolved backend gaps.
