# Railway template

This guide sets up the one-click **Deploy on Railway** template for ADK and publishes it in the
Railway marketplace. Template maintainers earn a share of what users spend on the services their
template creates (15% base, 25% when the maintainer answers user questions in Railway's template
queue), so keep the template working and answer its support threads.

Kickbacks are credited as Railway Credits by default. Cash withdrawals go through Stripe Connect
and are not available in every country (Railway lists Brazil among the unsupported ones); there,
the credits can still pay for the maintainer's own Railway usage.

## Services

| Service    | Source                                 | Config file                             | Public | Purpose                                     |
| ---------- | -------------------------------------- | --------------------------------------- | ------ | ------------------------------------------- |
| `Postgres` | Railway PostgreSQL database            | —                                       | No     | Data, E2E job queue and test videos         |
| `Redis`    | Railway Redis database                 | —                                       | No     | Read cache shared by the API instances      |
| `API`      | this repo, root directory `/apps/Backend`  | `/apps/Backend/railway.json`            | Yes    | REST API; applies migrations on start       |
| `Worker`   | this repo, root directory `/apps/Backend`  | `/apps/Backend/railway.e2e-worker.json` | No     | Runs E2E, integration and load tests; sleeps when idle |
| `Web`      | this repo, root directory `/apps/Frontend` | `/apps/Frontend/railway.json`           | Yes    | Web app (static build served by nginx)      |
| `MCP`      | this repo, root directory `/apps/Mcp`      | `/apps/Mcp/railway.json`                | Yes    | Remote MCP server for claude.ai, Claude Code |

Railway does not apply the root directory to the config file path, so each service needs the
absolute path from the table in **Settings → Config-as-code → Railway Config File**. The config
files set the Dockerfile, health check, restart policy and watch paths, so a push to one app does
not redeploy the others.

Service-to-service traffic uses the private network (`RAILWAY_PRIVATE_DOMAIN`). Only the browser
needs public domains: the web app calls the API from the user's browser, and assistants connect
to the MCP server from outside Railway.

Railway's private network is IPv6 only. The API and the worker listen on every address, and the
API's Redis client resolves IPv6 (`family: 0` in `apps/Backend/src/shared/cache.ts`), so the
plain `${{Redis.REDIS_URL}}` reference works without a `?family=0` suffix.

Redis is optional for the API (without `REDIS_URL` it caches in memory), but the template includes
it so that scaling the API to more than one replica keeps the cache consistent.

## Variables

Keep the service names exactly as above: the references below use them. `${{secret(...)}}` is
evaluated once, when a user deploys the template, so every deployment gets its own secrets.

### API

| Variable                     | Value                                                     | Description                                                                 |
| ---------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `PORT`                       | `3000`                                                    | Port the API listens on. Other services reference it.                       |
| `NODE_ENV`                   | `production`                                              | Runtime mode.                                                               |
| `DATABASE_PROVIDER`          | `postgres`                                                | Persistence driver. PostgreSQL is the only supported provider.              |
| `DATABASE_URL`               | `${{Postgres.DATABASE_URL}}`                              | Private connection string of the Postgres service.                          |
| `REDIS_URL`                  | `${{Redis.REDIS_URL}}`                                    | Private connection string of the Redis service (read cache).                |
| `INTEGRATION_ENCRYPTION_KEY` | `${{secret(64, "abcdef0123456789")}}`                     | 32-byte hex key that encrypts stored integration secrets. Never change it after the first deploy, or saved integrations can no longer be decrypted. |
| `OAUTH_STATE_SECRET`         | `${{secret(64)}}`                                         | Signs OAuth state during Google and GitHub sign-in.                         |
| `AUTH_CODE_SECRET`           | `${{secret(64)}}`                                         | Pepper for account-recovery code hashes.                                    |
| `API_PUBLIC_URL`             | `https://${{RAILWAY_PUBLIC_DOMAIN}}`                      | Public URL of this API, used for OAuth callbacks and secure cookies.        |
| `FRONTEND_URL`               | `https://${{Web.RAILWAY_PUBLIC_DOMAIN}}`                  | Public URL of the web app; OAuth sign-in returns here.                      |
| `E2E_WORKER_URL`             | `http://${{Worker.RAILWAY_PRIVATE_DOMAIN}}:${{Worker.PORT}}` | Private URL of the E2E worker, which the API wakes when a run is queued.  |
| `E2E_WORKER_TOKEN`           | `${{Worker.E2E_WORKER_TOKEN}}`                            | Shared token the API uses to call the worker.                               |
| `SMTP_URL`                   | *(empty, optional)*                                       | Nodemailer URL such as `smtps://user:password@smtp.example.com`. Needed only for password recovery emails; sign-up works without it. |
| `SMTP_FROM`                  | *(empty, optional)*                                       | Sender of recovery emails, for example `ADK <no-reply@example.com>`.        |
| `GOOGLE_CLIENT_ID`           | *(empty, optional)*                                       | Enables "Sign in with Google". Callback: `<API_PUBLIC_URL>/auth/oauth/google/callback`. |
| `GOOGLE_CLIENT_SECRET`       | *(empty, optional)*                                       | Secret of the Google OAuth client.                                          |
| `GITHUB_CLIENT_ID`           | *(empty, optional)*                                       | Enables "Sign in with GitHub". Callback: `<API_PUBLIC_URL>/auth/oauth/github/callback`. |
| `GITHUB_CLIENT_SECRET`       | *(empty, optional)*                                       | Secret of the GitHub OAuth app.                                             |

Test videos are stored in Postgres by default. To keep the database small, users can set the
`E2E_R2_*` variables from [apps/Backend/.env.example](../../apps/Backend/.env.example) on both the
API and the worker.

### Worker

| Variable                     | Value                                        | Description                                                         |
| ---------------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| `PORT`                       | `3001`                                       | Port the worker listens on; the API reaches it on the private network. |
| `NODE_ENV`                   | `production`                                 | Runtime mode.                                                       |
| `DATABASE_PROVIDER`          | `postgres`                                   | Persistence driver.                                                 |
| `DATABASE_URL`               | `${{Postgres.DATABASE_URL}}`                 | Same database as the API (job queue, runs and videos).              |
| `INTEGRATION_ENCRYPTION_KEY` | `${{API.INTEGRATION_ENCRYPTION_KEY}}`        | Must match the API to read repository and test-management credentials. |
| `E2E_WORKER_TOKEN`           | `${{secret(48)}}`                            | Token the API presents when it wakes the worker.                    |
| `E2E_WORKER_CONCURRENCY`     | `2`                                          | Parallel test runs. Each Chromium needs about 0.5 vCPU and 500 MB.  |
| `API_TESTS_WORKER_CONCURRENCY` | `2`                                        | Integration and load test runs executed at once by the worker.      |
| `RAILWAY_DOCKERFILE_PATH`    | `Dockerfile.e2e-worker`                      | Builds the Playwright image instead of the API image.               |

No public domain. The worker sleeps when idle (`sleepApplication`), so it costs nothing between
test runs, and wakes on the API's private request.

### Web

| Variable            | Value                                    | Description                                                                 |
| ------------------- | ---------------------------------------- | --------------------------------------------------------------------------- |
| `VITE_API_BASE_URL` | `https://${{API.RAILWAY_PUBLIC_DOMAIN}}` | Public API URL. It is compiled into the build, so redeploy `Web` after changing the API domain. |

### MCP

| Variable                | Value                                                   | Description                                                                 |
| ----------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| `PORT`                  | `3333`                                                  | Port of the Streamable HTTP endpoint (`/mcp`).                              |
| `ADK_API_URL`           | `http://${{API.RAILWAY_PRIVATE_DOMAIN}}:${{API.PORT}}`  | API the MCP server calls, over the private network.                         |
| `ADK_MCP_PUBLIC_URL`    | `https://${{RAILWAY_PUBLIC_DOMAIN}}`                    | Public URL assistants connect to. Enables the OAuth flow for remote connectors. |
| `ADK_MCP_OAUTH_SECRET`  | `${{secret(48)}}`                                       | Signs the OAuth tokens issued to remote connectors.                         |
| `ADK_MCP_ALLOWED_HOSTS` | `${{RAILWAY_PUBLIC_DOMAIN}}`                            | Accepted Host headers (DNS-rebinding protection). Add custom domains here.  |

## Creating the template

1. **Build the reference project.** In Railway, create a project, add a PostgreSQL database, a
   Redis database and four services from this GitHub repository. Name them `Postgres`, `Redis`,
   `API`, `Worker`, `Web` and `MCP`, and set each root directory, config file and variables as
   described above. Generate public domains for `API`, `Web` and `MCP` only.
2. **Check it end to end.** Open the web app, create an account and a workspace, queue an E2E
   run and an integration test run to confirm the worker wakes, check that the API log says
   `[Cache] Using Redis.`, and connect an assistant to `https://<mcp-domain>/mcp`.
3. **Generate the template.** In the project, open **Settings → Generate Template from
   Project**. In the composer, confirm every variable has a description (copy them from the
   tables above), mark optional variables as optional and upload a square icon with a
   transparent background for the template and for each service.
4. **Write the overview.** Paste [railway-template-overview.md](railway-template-overview.md)
   into the template description. It follows the structure Railway asks verified templates to
   use.
5. **Publish** the template from **Workspace Settings → Templates**. Publish it from a workspace
   with your own professional name: the marketplace shows it as the author.
6. **Add the button.** Replace `TEMPLATE_CODE` in the README's Deploy on Railway button with the
   code from the template URL (`https://railway.com/deploy/<code>`).
7. **Join the partner program** at [railway.com/partners](https://railway.com/partners) so the
   template can be verified and earn kickbacks. Railway also asks partners for a standalone
   deployment guide: the README's "Deploy on Railway" section and this document can serve as one.
8. **Support users** from the template queue in Central Station. Answering questions is what
   raises the kickback from 15% to 25%.

## Updating the template

Template deployments track this repository. Pushes to the default branch reach existing
deployments as template updates, so keep migrations backward-compatible (expand, migrate, then
contract) and never rename the variables above: renaming one breaks every deployment that
references it.
