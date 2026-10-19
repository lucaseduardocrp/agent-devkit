---
name: secure-integrations
description: "Use when adding or reviewing external APIs, webhooks, LLMs, storage, queues, plugins, tools, or protocol integrations."
user-invocable: true
---

# Secure Integrations

## Objective

Add external capabilities behind safe interfaces with explicit credentials, scopes, timeouts, retries, audit, and failure behavior.

## Workflow

1. Define a capability port independently of the provider SDK.
2. Define configuration schemas and secret references.
3. Validate URLs, transport, payloads, and response schemas.
4. Add timeout, cancellation, retry, and rate-limit policies.
5. Redact secrets and sensitive content from logs.
6. Restrict data by authorization context.
7. Enforce allowlists, permissions, and sandbox limits for tools.
8. Add provider fakes and failure tests.
9. Add health checks and operational documentation.

## Security checks

- SSRF and redirect validation;
- webhook authenticity and replay protection;
- secret rotation and scanning;
- least-privilege credentials;
- payload and schema limits;
- audit events for sensitive actions;
- no arbitrary code execution in the API process.

## Output

Port, adapter, configuration, threat model, failure policy, tests, metrics, and runbook updates.
