# Vendored backend E2E runner

Copies of `apps/Backend/src` files (same layout), so `devkit runner` runs specs exactly like the
ADK workers. Do not edit them here: change the backend files and run
`npm run sync-e2e-runner`. `tests/e2e-runner-parity.test.ts` fails while they differ.
