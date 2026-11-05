# ADR-0002: Personal Credentials and Isolated Scripts in Integration Tests

## Status

Accepted

## Context

Integration Tests is a Bruno/Postman-like API client: collections, folders and requests are shared
by every member of a workspace, and runs execute on the ADK workers or on the requesting member's
computer (`devkit runner`). Two features change what the module stores and executes:

- Credentials (tokens, passwords, API keys, client secrets, proxy passwords, private keys) used to
  live inside the shared collection or environment, so every member ran requests with the same
  identity. Credentials must be personal: each member uses their own.
- Collections, folders and requests gain pre-request, post-response and test scripts (JavaScript,
  Bruno `bru`/`req`/`res` and Postman `pm` APIs). Scripts are code written by workspace members, and
  the workers may run inside the API process, which holds the database URL and the encryption key.

## Decision

**Personal vault.** `api_personal_values` stores, per workspace member and encrypted (AES-GCM), the
value of every sensitive field, identified by a ref: `var:<key>` for secret variables, `auth:<owner>:<field>`
for the credential fields of an auth (`AUTH_SECRET_FIELDS`), `proxy:<field>` and `cert:<index>:<field>`.
On save, a literal value in one of these fields moves to the vault of the member who saved and is
blanked in the shared document; a value made only of `{{variable}}` references stays shared, and
secret variables never keep a shared value. Views list the refs the reader has set
(`personalSecrets`), never values. Run payloads are built with the requester's own values only.
Runtime variables (captures, `bru.setVar`) and cookies left by a run are kept per member in the same
vault (scope `runtime`) and never stored in the run row.

**Isolated scripts.** Scripts never run in the process that executes the run. Each run starts one
child Node process with an empty environment, Node's permission model (no file system, child
processes, workers or addons), a heap cap and a wall-clock timeout per script; scripts run there in a
fresh `vm` context with an allow-listed API. Network access from scripts (`bru.sendRequest`) goes back
to the parent, which applies the run's target guard, proxy and TLS settings.

**Dependency-free engine.** The protocols (HTTP over node:http with proxies and client certificates,
WebSocket, SSE, TCP/TLS/UDP, gRPC with a protobuf codec and server reflection, the auth schemes and
the cookie jar) are written on Node built-ins, so the CLI keeps a byte-identical copy of the engine.

## Consequences

- A member who opens a collection shared by someone else sets their own credentials before running;
  a variable reference (`{{token}}`) is the way to share where a credential goes, not its value.
- Credentials stored before this change move to the vault of the collection's creator (environments:
  of their creator when known, otherwise they are cleared and must be set again).
- Exports never contain credentials.
- A `vm` escape inside the child reaches a process without secrets, files or the ability to spawn;
  the worker's network policy remains the boundary for outbound traffic.
- Every engine file is synced to the CLI (`apps/Cli/scripts/sync-apitests-engine.mjs`).

## Validation

- Tests: two members of a workspace each run with their own token; the shared document and run rows
  never contain either.
- Tests: a script that escapes the `vm` cannot read the parent's environment or files, nor spawn
  processes; timeouts kill the child.
- `apps/Cli/tests/apitests-engine-parity.test.ts` fails while the CLI copy differs.
