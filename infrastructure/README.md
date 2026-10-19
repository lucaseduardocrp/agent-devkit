# Runtime infrastructure

The complete self-hosted stack (PostgreSQL, API, web app, E2E worker, MCP server and Mailpit)
is the root [compose.yaml](../compose.yaml), configured by the setup wizard in [setup](../setup)
and started with `adk.cmd` or `./adk.sh`. See [docs/self-hosting.md](../docs/self-hosting.md).

`docker/compose.dev.yml` is for development: it loads `../apps/Backend/.env` into the migration,
API and worker containers. Use it when local containers should connect to the staging database
configured by `DATABASE_URL`; it does not start a local PostgreSQL container.
It also starts the Playwright E2E worker and connects the API to it. Set
`E2E_WORKER_TOKEN` in `apps/Backend/.env` to a random string of at least 16 characters;
the API and worker share this value through the same env file. Run
`docker compose -f infrastructure/docker/compose.dev.yml up -d --build` to start the stack,
or append `e2e-worker` to start only the worker. Check it with
`docker compose -f infrastructure/docker/compose.dev.yml ps -a`.
When running the API directly with `npm start` while keeping the worker in Docker, set
`E2E_WORKER_URL=http://localhost:3001` in the ignored `apps/Backend/.env` and restart the API.
The worker port is published only on the host loopback interface. For a web app running on the
Windows host, set the E2E target to `http://host.docker.internal:<app-port>` and start the app
on an interface reachable from Docker (for Angular CLI, use `ng serve --host 0.0.0.0`).
If that web app calls another local API through `localhost`, route those calls through its
development server instead: inside the worker's browser, `localhost` refers to the worker.
When the app only works on its original `localhost` origin (for example, because an SSO or CORS
policy allows only that origin), start the optional `local-target-proxy` service with
`LOCAL_TARGET_PORT=<app-port> docker compose -f infrastructure/docker/compose.dev.yml --profile local-target up -d`
and set the E2E target to `http://localhost:<app-port>`. The proxy shares the worker's network
namespace and forwards that port to `host.docker.internal`, so the browser keeps the original
origin. The default port is 8014.

## Environment matrix

| Environment | Runtime                   | Database                | Secrets                   | Deployment gate                        |
| ----------- | ------------------------- | ----------------------- | ------------------------- | -------------------------------------- |
| development | Docker Compose or Node 24 | Local PostgreSQL 17     | Local ignored files       | Backend verify                         |
| test        | CI Node 24                | Ephemeral/fake adapters | CI secret store           | Tests and coverage                     |
| staging     | Immutable Backend image   | Managed PostgreSQL      | Secret manager references | Smoke, migration and restore rehearsal |
| production  | Same promoted image       | HA managed PostgreSQL   | Secret manager references | Approval, backup and readiness         |

`PORT`, `NODE_ENV`, `LOG_LEVEL` and `DATABASE_URL` are validated at process startup. Real
credentials must never be placed in Compose, an image, source control, logs or test fixtures.

`DATABASE_PROVIDER` selects the persistence driver and must be configured together with
`DATABASE_URL`. Currently, `postgres` is the only supported provider. Setting `sqlserver` is
planned for future releases but is currently rejected at runtime startup by configuration validation;
changing `DATABASE_PROVIDER` alone is insufficient until SQL Server has its own physical schema,
migration history, adapter implementation, composition registration and contract test suite.

PostgreSQL connection strings use the `postgresql://...` format. For local host development,
the URL targets `localhost:5432` (e.g. `postgresql://<user>:<password>@localhost:5432/<database>`).
In Docker Compose, services resolve the database container via the service name `database`
(e.g. `postgresql://<user>:<password>@database:5432/<database>`).

## API and dependencies

For local Node development, run `npm start` from `apps/Backend`. The `prestart`
hook rebuilds `dist` from the current source before starting the API. Runtime
images that contain only `dist` skip this rebuild.
The `prestart` hook loads `.env` and deploys pending Prisma migrations when
`DATABASE_PROVIDER=postgres`; a migration failure stops startup. In-memory mode
does not run migrations. Direct `node dist/src/bootstrap/server.js` execution bypasses
this hook, so deploy migrations first. Docker Compose retains its migration service.

To validate Brain persistence against the configured PostgreSQL database after a build,
run `node --env-file=.env scripts/validate-brain-persistence.mjs` from `apps/Backend`.
It creates a unique temporary schema, copies only the structure of the two knowledge
tables, exercises HTTP edit/delete/push/sync and rollback, and drops that schema in
`finally`. The database role needs schema creation privileges. Existing application
rows are untouched; Azure responses are simulated.

The API runs from `apps/Backend/src/bootstrap/server.ts`. Long-running synchronization and
agent execution must run as a separately deployed worker using the same immutable image and
application ports; no production worker is enabled until a queue adapter and worker composition
root are implemented. PostgreSQL is the transactional dependency. LLM, embedding and Wiki
providers remain outbound adapters and must receive URLs and secret references per environment.

## Backup, restore and rollback

- Production PostgreSQL requires encrypted daily full backups plus point-in-time recovery, with
  retention set by the owning environment.
- Restore is rehearsed in staging before release: restore into a new database, run integrity and
  row-count checks, then attach a staging API and verify readiness.
- Schema changes use expand/migrate/contract. A release is rolled back by promoting the prior
  image while retaining backward-compatible schema changes.
- A destructive or incompatible migration requires a verified pre-deployment backup, a named
  owner, an estimated recovery time and explicit release approval.

Infrastructure changes are reviewed as Dockerfile/Compose/documentation diffs and use pinned
major runtime versions. Production provisioning remains intentionally out of scope until the
target cloud and secret manager are selected.
