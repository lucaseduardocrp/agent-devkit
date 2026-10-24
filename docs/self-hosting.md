# Self-hosting ADK with Docker

This guide covers everything after the [Quick start](../README.md#quick-start): how the setup
works, the settings it writes, HTTPS and network access, backups, upgrades and troubleshooting.

## How the setup works

`adk.cmd` (Windows) and `./adk.sh` (macOS and Linux) do three things:

1. Check that Docker is installed and running.
2. If there is no `.env` file yet, or when you run `adk setup`, start the setup wizard: a small
   container (`setup/compose.yaml`) that serves a web page at `http://localhost:4000` and writes
   `.env` in the ADK folder. The wizard listens on this computer only and stops when you save.
3. Run `docker compose up -d --build --wait` with the root [compose.yaml](../compose.yaml) and
   wait until every service is healthy.

Running the wizard again loads the current `.env`, keeps the existing keys and saves the previous
file as `.env.backup`. Settings the wizard does not know about are kept as they are.

To do the same without the launchers:

```bash
docker compose -f setup/compose.yaml up   # then open http://localhost:4000
docker compose up -d --build              # after saving in the wizard
```

If port 4000 is taken, choose another one: `ADK_SETUP_PORT=4100 ./adk.sh setup`
(PowerShell: `$env:ADK_SETUP_PORT='4100'; .\adk setup`).

## Settings reference

The wizard writes these variables to `.env`. You rarely need to edit the file by hand; if you
do, restart with `adk` / `./adk.sh` afterwards.

| Variable                        | Default                  | Purpose                                                        |
| ------------------------------- | ------------------------ | -------------------------------------------------------------- |
| `COMPOSE_PROFILES`              | `e2e,mcp,mail`           | Optional services to run: `e2e` worker, `mcp` server, `mail` (Mailpit) |
| `ADK_HOST`                      | `localhost`              | Host name or IP used to build the public URLs                  |
| `ADK_BIND_ADDRESS`              | `127.0.0.1`              | `0.0.0.0` makes the ports reachable from other devices         |
| `ADK_WEB_PORT`                  | `8080`                   | Web app port                                                   |
| `ADK_API_PORT`                  | `3000`                   | API port                                                       |
| `ADK_MCP_PORT`                  | `3333`                   | MCP server port                                                |
| `ADK_MAIL_PORT`                 | `8025`                   | Mailpit inbox port                                             |
| `FRONTEND_URL`                  | `http://localhost:8080`  | Public URL of the web app (OAuth sign-in returns here)         |
| `API_PUBLIC_URL`                | `http://localhost:3000`  | Public URL of the API. Compiled into the web app               |
| `ADK_MCP_PUBLIC_URL`            | `http://localhost:3333`  | Public URL of the MCP server, used for its OAuth flow          |
| `ADK_MCP_ALLOWED_HOSTS`         | *(empty)*                | Extra `Host` headers the MCP server accepts                    |
| `DATABASE_PASSWORD`             | generated                | PostgreSQL password. Only applied when the database is created |
| `INTEGRATION_ENCRYPTION_KEY`    | generated                | Encrypts saved integration credentials. **Never change it**    |
| `OAUTH_STATE_SECRET`            | generated                | Signs the Google and GitHub sign-in state                      |
| `AUTH_CODE_SECRET`              | generated                | Pepper for password-recovery codes                             |
| `E2E_WORKER_TOKEN`              | generated                | Shared by the API and the E2E worker                           |
| `ADK_MCP_OAUTH_SECRET`          | generated                | Signs the tokens issued to remote MCP clients                  |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | Mailpit | Email for password recovery |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | *(empty)*     | Enables "Sign in with Google"                                  |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | *(empty)*     | Enables "Sign in with GitHub"                                  |
| `E2E_WORKER_URL`                | `http://worker:3001`     | Set when the E2E worker runs; the API sends test runs to it    |
| `E2E_WORKER_CONCURRENCY`        | `2`                      | Parallel test runs (about 0.5 CPU and 500 MB each)             |
| `API_TESTS_WORKER_CONCURRENCY`  | `2`                      | Integration and load test runs executed at once by the worker  |
| `API_TESTS_ALLOW_PRIVATE_NETWORK` | `false`                | Lets remote API/load tests reach private networks (10.x, 192.168.x); loopback and the metadata endpoint stay blocked |
| `ADK_HOST_ACCESS`               | `auto`                   | Tests of `http://localhost` reach this computer. `auto`: on while the ports listen on `127.0.0.1` only, off when they are open to the network; `true` or `false` force it |
| `E2E_R2_URL`, `E2E_R2_ACCESS_KEY_ID`, `E2E_R2_SECRET_ACCESS_KEY`, `E2E_R2_PREFIX` | *(empty)* | Store test videos in Cloudflare R2 instead of PostgreSQL |
| `ADK_HUB_URL`                   | public ADK Hub           | Another hub index for the Hub tab of the Agents page (e.g. a mirror) |
| `ADK_HUB_GITHUB_TOKEN`          | *(empty)*                | Read-only GitHub token; lifts the limit of 60 anonymous calls an hour |
| `LOG_LEVEL`                     | `info`                   | `debug`, `info`, `warn` or `error`                             |

LLM providers, Azure DevOps, GitHub repositories and other integrations are not configured here:
each workspace adds them in the web app under **Connect**, and their credentials are stored
encrypted with `INTEGRATION_ENCRYPTION_KEY`.

## Access from other devices and HTTPS

By default every port listens on `127.0.0.1`, so only this computer can open ADK.

- **Your local network**: in the wizard, set **Host name or IP** to this computer's IP address
  or name (for example `192.168.0.20`) and turn on **Allow access from other devices**.
- **The internet, with HTTPS**: put a reverse proxy or tunnel (Caddy, nginx, Traefik,
  Cloudflare Tunnel) in front of the web app, API and MCP ports, then turn on **Use custom public
  URLs** in the wizard and enter the HTTPS addresses. The web app has the API address compiled
  in, so the next start rebuilds it automatically.

claude.ai and other remote MCP connectors reach the MCP server from the internet, so they need
its public HTTPS URL. Assistants on this computer connect to `http://localhost:3333/mcp` (the MCP
server container), or use the optional `devkit` CLI.

Opening the ports to the network also turns off [host access](#testing-apps-that-run-on-your-computer),
so a shared server does not let its users reach the services of the machine it runs on.

## Testing apps that run on your computer

While ADK is reachable from this computer only (the default), integration, load and E2E tests of
`http://localhost:<port>` (or `127.0.0.1`) run on the ADK workers and reach the apps running on
this computer, even ones listening on `127.0.0.1` only. Nothing else is needed: no tunnel, no
`devkit runner`, no `--host 0.0.0.0`.

The workers send `localhost` to Docker's `host.docker.internal` without changing the request:
API requests still say `Host: localhost` and use the `localhost` TLS name, and the browser keeps
the `http://localhost:<port>` origin, so cookies, CORS, sign-in redirects and dev servers that only
accept `localhost` behave as in your own browser. The code is in
`apps/Backend/src/shared/host-access.ts`; `ADK_HOST_ACCESS` (see the settings reference) turns it
on or off.

With access from other devices turned on, host access is off: use
`http://host.docker.internal:<port>` as the target and start your app on an interface Docker can
reach, or run the tests in your own browser with `devkit runner` (see
[apps/Cli/README.md](../apps/Cli/README.md)).

Integrations that call services on your computer, such as Ollama, use
`http://host.docker.internal:<port>`.

## Backups

Two things hold your installation: the `.env` file and the PostgreSQL volume.

```bash
# Database backup (run in the ADK folder)
docker compose exec -T database pg_dump -U adk -d adk --format=custom > adk-backup.dump

# Restore into a running stack
docker compose exec -T database pg_restore -U adk -d adk --clean --if-exists < adk-backup.dump
```

Keep `.env` together with the backup: a restored database is useless without the same
`INTEGRATION_ENCRYPTION_KEY`.

## Upgrades

Run `adk update` (Windows) or `./adk.sh update`. It downloads the latest version with
`git pull`, rebuilds the images and restarts. The API applies any new database migrations when it
starts. If you downloaded a ZIP instead of cloning, replace the folder's contents with the new
version, keeping your `.env`, and run `adk` again.

## Troubleshooting

| Problem                                   | What to do                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| "Docker is not running"                   | Start Docker Desktop and wait until it reports that the engine is running. |
| "required variable … is missing a value"  | There is no `.env` yet. Run `adk` / `./adk.sh` to open the setup wizard.   |
| A port is already in use                  | Run the setup again and choose another port on the **Access** step.        |
| The first start seems stuck               | The first build downloads and compiles everything; the E2E worker image alone is about 2 GB. Follow it with `adk logs`. |
| A service is unhealthy                    | `adk status` shows which one; `adk logs api` (or `web`, `worker`, `mcp`) shows why. |
| The API cannot connect to the database    | The database password was changed after the database was created. Restore the previous value from `.env.backup`. |
| Saved integrations stopped working        | `INTEGRATION_ENCRYPTION_KEY` changed. Restore the previous value from `.env.backup`. |
| `.env` belongs to root (Linux)            | Run the wizard through `./adk.sh setup`, which runs it with your user id.  |

To start over with an empty database, which **deletes all ADK data**:

```bash
docker compose down --volumes
```
