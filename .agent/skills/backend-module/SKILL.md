---
name: backend-module
description: "Use when implementing or evolving a TypeScript backend module, HTTP route, use case, repository, worker, event, provider adapter, or API contract."
user-invocable: true
---

# Backend Module

## Objective

Implement backend behavior with transport at the edge and framework-independent domain and application code underneath.

## Workflow

1. Identify the use case and acceptance criteria.
2. Define input/output schemas and error codes.
3. Implement domain invariants and application orchestration.
4. Add ports for storage, providers, queues, or tools.
5. Implement adapters and wire them in the composition root.
6. Add authorization, limits, timeout, and cancellation.
7. Add tests proportional to risk.
8. Run focused tests, typecheck, lint, and build.

## Guardrails

- controllers translate transport only;
- no framework imports in domain or application layers;
- no secrets in code, fixtures, logs, or responses;
- validate every external input;
- use idempotency for retried commands;
- do not execute arbitrary code in the main API process.

## Output

Changed files, public contracts, migration needs, tests run, limitations, and rollback notes.
