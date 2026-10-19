---
name: architecture-design
description: "Use when designing or reviewing architecture, module boundaries, ports, adapters, dependency direction, events, workers, scalability, or ADRs."
user-invocable: true
---

# Architecture Design

## Objective

Design software architecture with clear boundaries, replaceable infrastructure, and explicit trade-offs.

## Workflow

1. State the business capability and constraints.
2. Identify domain rules, use cases, and external boundaries.
3. Define ports for persistence, providers, messaging, and tools.
4. Map dependencies and reject inward dependencies on adapters.
5. Define contracts, events, transactions, and authorization context.
6. Compare a simpler alternative.
7. Record important decisions as an ADR.
8. Provide acceptance criteria and focused validation.

## Guardrails

- prefer modularity before distribution;
- keep framework code at the edge;
- separate visual state from executable state;
- make providers replaceable by fakes;
- require authorization context for protected data;
- add abstractions only when they protect a real boundary.

## Output

Decision, affected modules, dependency map, contracts, risks, migration impact, rollback plan, and validation checklist.
