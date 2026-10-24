# Vendored API test engine

Copies of `apps/Backend/src/modules/apitests/engine`, so `devkit runner` executes integration and
load runs exactly like the ADK workers. Do not edit them here: change the backend files and run
`node scripts/sync-apitests-engine.mjs`. `tests/apitests-engine-parity.test.ts` fails while they
differ.
