# ADK desktop app

`@agent-devkit/desktop` packages ADK as an Electron app, so people can install it without Docker or
a terminal. One window, one installer.

## How it works

On launch the main process ([src/main/index.ts](src/main/index.ts)):

1. Reads or creates `settings.json` in the user's data folder: ports (3000, 3333 and 54329 when
   free, any free port otherwise) and generated secrets.
2. Starts the bundled PostgreSQL 17 (`embedded-postgres`, loopback only), creates the `adk`
   database on the first launch and applies the Prisma migrations
   ([src/main/migrations.ts](src/main/migrations.ts); same `_prisma_migrations` table as
   `prisma migrate deploy`, so the Prisma CLI is not shipped).
3. Starts the API (`apps/Backend`) and the MCP server (`apps/Mcp`) as child processes using
   Electron's own Node runtime (`ELECTRON_RUN_AS_NODE`), so Node.js is not required.
4. Serves the web app from `app://adk/` (a fixed origin, so the sign-in survives restarts) and the
   preload script hands it the API address as `window.adkDesktop.apiUrl`.

## The database

- **Lifecycle** ([src/main/postgres.ts](src/main/postgres.ts)): stopped with `pg_ctl stop -m fast`
  (the bundled library kills it on Windows, which forces crash recovery on the next start). Before
  choosing ports, a PostgreSQL that a crash left running on the data folder is stopped through
  `pg_ctl`, never by killing its pid, which the system may have reused.
- **Backups** ([src/main/backup.ts](src/main/backup.ts)): the bundled binaries have no `pg_dump`,
  so a backup is logical and made by the app: a gzip file of JSON lines with a header (format,
  applied migrations, integration key), then each table's columns and rows as text, read through a
  cursor in one `REPEATABLE READ` snapshot. The schema is not saved; a restore rebuilds it from the
  migrations the backup lists, loads the rows with `session_replication_role = replica` (no
  foreign key order needed), moves serial sequences past the restored values, then applies this
  version's newer migrations so data migrations also run on old rows. Without superuser rights
  (a hosted database), the foreign keys are dropped instead and added back before the commit,
  which checks every row loaded.
- **Cloud database** ([src/main/cloud-database.ts](src/main/cloud-database.ts), Integrations >
  Storage > PostgreSQL in the app): the data can live in a hosted PostgreSQL (Neon, Supabase, RDS,
  Railway…) instead of this computer. The main process checks the URL, then either copies this
  computer's data into an empty database (a backup restored there) or uses one that already holds
  ADK data; a database with other tables, or one used by a newer app, is refused. The URL is saved
  in `settings.json` sealed with the system keychain (`safeStorage`, DPAPI on Windows), with the
  integration key of that database; while it is in use the local PostgreSQL does not start, and
  backups and restores act on the cloud database. Disconnecting goes back to the local data as it
  was, or copies the cloud data over it; the cloud database is never changed by either. When it
  cannot be reached at launch, the user retries, goes back to the local data, or quits. The web app
  reaches these calls through `window.adkDesktop.storage` ([src/preload](src/preload)); only the
  page of this window may call them.
- **Docker dumps**: a data-only `pg_dump --column-inserts` is split into statements as it streams
  ([src/main/backup-format.ts](src/main/backup-format.ts)); only `INSERT`, `SET`, `set_config` and
  `setval` run, and anything else refuses the whole file. The schema comes from this version's
  migrations, so the Docker install must be on the same ADK version.
- The tests in [tests/backup.test.ts](tests/backup.test.ts) run against a real PostgreSQL from the
  same bundled binaries.

## Development sessions (Development > Code)

The app executes coding sessions itself, so `devkit develop` is not needed here.

- **Runner** ([src/main/development.ts](src/main/development.ts)): each session is given a
  repository folder (in the new-session form, or under Environment for a session queued elsewhere).
  Every five seconds the app asks the API for the signed-in person's queued sessions and starts
  the ones that have a folder: first run, retry and changes requested alike. The web app hands
  over its session token when Development opens; an expired token signs the runner out until the
  web app connects again. Closing the app stops the agents, and their sessions fail and can be
  retried.
- **Same code as the CLI**: [src/vendor/development](src/vendor/development) is a copy of
  `apps/Cli/src/development` (worktrees, coding CLIs, progress, diff). After changing those files
  run `node scripts/sync-development-runner.mjs`;
  [tests/development-runner-parity.test.ts](tests/development-runner-parity.test.ts) fails while
  the copies differ.
- **Live screen**: Development follows the API through server-sent events
  (`/development/stream`, the same bus as the Agent Map), so sessions, changes and the pipeline
  update as the agent works; every report of the agent also makes the open files and changes be
  read from the worktree again.
- **Worktree access** ([src/main/development-ipc.ts](src/main/development-ipc.ts)): the web app
  reads, searches and saves the files of the worktree
  ([workspace-files.ts](src/main/workspace-files.ts), never outside it), reads the changes of the
  branch against its base branch, another branch or one commit, opens a file in the default
  application or VS Code or shows it in the Explorer, and runs commands in a terminal
  ([terminal.ts](src/main/terminal.ts)). The terminal runs one line at a time in a shell
  of its own (PowerShell on Windows), follows `cd`, and is not a pseudo-terminal: commands that
  ask for input do not work.
- `git` and the session's coding CLI (`claude`, `codex` or `gemini`) must be installed and signed
  in on this computer. Folders and worktrees are remembered in `development.json` in the data
  folder.

## Differences from the Docker stack

No Redis (the API caches in memory), no separate E2E worker (the
API runs E2E, integration and load tests itself), no Mailpit and no Telegram bridge. The API
listens on `127.0.0.1` through the `HOST` variable. Host access is on (`ADK_HOST_ACCESS=true`, alias
`localhost`), so tests of apps on `localhost` run without `devkit runner` or a tunnel.

Everything E2E runs on this computer, and only the results leave it (published to the test
management platform, or kept in the database): the API starts with `ADK_DESKTOP=1`, which makes
every E2E run, and the exploration of Test > Sources, use this process's own browser, whatever
the target a run was saved with. No run waits for `devkit runner` or a worker, and the web app does
not offer "where to run" there.

## Commands

| Command            | What it does                                             |
| ------------------ | -------------------------------------------------------- |
| `npm run dev:live` | Opens the app with live reload (see below)               |
| `npm run stage`    | Builds the web app, API and MCP server into `stage/`     |
| `npm run dev`      | Stages, compiles and opens the app as it will ship       |
| `npm run pack`     | Unpacked app in `release/` (to test the packaged layout) |
| `npm run dist`     | Installers for the current system in `release/`          |
| `npm run verify`   | Format, lint, types and tests (100% coverage)            |

If `ELECTRON_RUN_AS_NODE` is set in your shell (VS Code's terminal can do it), unset it before
`npm start`, or Electron runs as plain Node (`dev:live` unsets it itself).

## Developing screens and features

`npm run dev:live` ([scripts/dev-live.mjs](scripts/dev-live.mjs)) runs the Vite dev server of
`apps/Frontend` and `tsc --watch` for `apps/Backend` and `apps/Mcp`, then opens the app on the dev
server. Edit a screen and the window updates at once; edit the API or the MCP server and the app
restarts that service when the build settles (`[live] The API is back` in the terminal). The data
lives apart from the installed app's, in `Agent DevKit Dev` in the user's app data folder. Close the
window or press Ctrl+C to stop everything. Changes to `apps/Desktop/src` itself need a new
`npm run dev:live`.

Screens and endpoints belong in `apps/Frontend` and `apps/Backend`, where they serve the desktop,
Docker and Railway installs alike. The web app knows it runs in the desktop app when
`window.adkDesktop` exists; anything native (menus, file dialogs) goes through the preload script
([src/preload/index.cts](src/preload/index.cts)), which exposes named functions, never
`ipcRenderer` itself.

Release: push a `desktop-v<version>` tag; [desktop-release.yml](../../.github/workflows/desktop-release.yml)
builds the Windows, macOS and Linux installers.
