# ADR-0001: Modular Backend Boundaries

## Status

Accepted

## Context

The rewrite must preserve existing behavior while allowing independent evolution of HTTP transport, business modules, persistence, external providers, and background processing.

## Decision

The backend is organized into four dependency layers:

1. `domain`: entities, value objects, invariants, domain services, and domain events.
2. `application`: commands, queries, use cases, ports, and application errors.
3. `adapters`: Express HTTP, persistence, provider clients, queues, and external integrations.
4. `bootstrap`: composition root, configuration, process startup, and dependency wiring.

Dependencies point inward. Domain code must not import Express, database clients, ORM models, provider SDKs, or MCP SDKs. Application code depends only on domain types and ports. Adapters implement ports. Bootstrap is the only place that selects concrete implementations.

DTOs, persistence records, and domain entities remain separate models. Authorization context is passed to application use cases explicitly. External calls require schemas, timeout, cancellation, retry, and redaction policies.

## Consequences

- Use cases can run from HTTP, workers, tests, or command-line adapters.
- Providers can be replaced with deterministic fakes.
- API contracts can evolve without exposing domain entities.
- More files and interfaces are required at module boundaries.
- Integration behavior must be tested through contract tests.

## Validation

- ESLint forbids framework imports from domain/application paths.
- TypeScript strict mode is enabled.
- Unit tests use ports and fakes.
- Each application gate requires format, lint, typecheck, and 100% coverage.
