# Vendored E2E runner

Copies of `apps/Backend/src/modules/e2e` files, so `devkit runner` runs specs exactly like the
ADK workers. Do not edit them here: change the backend files and run
`node scripts/sync-e2e-runner.mjs`. `tests/e2e-runner-parity.test.ts` fails while they differ.
