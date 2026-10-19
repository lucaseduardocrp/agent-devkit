---
name: parity-migration
description: "Use when migrating behavior between implementations, comparing old and new APIs, preserving compatibility, planning cutover, or defining rollback."
user-invocable: true
---

# Compatibility Migration

## Objective

Preserve observable behavior while moving from one implementation, platform, or architecture to another.

## Workflow

1. Identify the old entry point and behavior.
2. Capture sanitized input/output fixtures.
3. Record status codes, headers, side effects, events, and persistence effects.
4. Map old behavior to replacement use cases and adapters.
5. Add compatibility routes or adapters while consumers remain.
6. Compare golden outputs and negative cases.
7. Test retries, cancellation, empty results, and duplicate events.
8. Define dual-run, cutover, and rollback criteria.

## Guardrails

- never copy credentials or personal data into fixtures;
- separate observed behavior from planned behavior;
- document intentional differences;
- remove compatibility only after migration evidence exists.

## Output

Matrix with old behavior, new behavior, evidence, differences, risks, tests, and migration status.
