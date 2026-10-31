---
name: adk-api-tests
description: Use when the user wants API integration tests (requests with assertions, a collection for Postman, Insomnia or Bruno) or a load, stress, spike, soak or performance test of an API with ADK. Covers generating them from test plans, Brain pages, specs and PBIs, importing collections, running them and reading the results.
---

# ADK API tests: integration and overload

Integration tests are **collections** of HTTP requests with assertions and captures; overload tests
are **load scenarios** that replay requests of a collection under a load profile. Both run on the
ADK workers (`target: "remote"`, public URLs) or on the user's computer through `devkit runner`
(`target: "local"`, for localhost and internal networks).

## Write integration tests

1. Find the sources: `testplans_list`, `brain_search`, `spec_list`, `pbi_list`. Ask for the base URL
   of the system under test when the sources do not say it.
2. Host mode (no server LLM): `integration_prepare_generation { sources, instructions?, baseUrl? }`
   returns the instruction, the context and the collection format. Write the collection yourself and
   save it with `integration_save_collection { collection }`.
   Server mode: `integration_generate { sources, instructions?, baseUrl? }` writes and saves it.
3. Chain requests like a client: capture tokens and created ids (`captures`) and reuse them as
   `{{variable}}`. Assert status codes, required fields, values and formats from the sources only.
   Fill bodies with realistic data using mock values, which make a new value on every send:
   `{{$randomFullName}}`, `{{$randomEmail}}`, `{{$randomCPF}}`, `{{$randomPhoneNumber}}`,
   `{{$randomCEP}}`, `{{$randomPrice}}`, `{{$guid}}`... (the full list comes with
   `integration_prepare_generation`). Write numbers and booleans without quotes
   (`"age": {{$randomAge}}`); keep fixed values where an assertion needs to know the data.
4. Credentials are **personal to each workspace member**: tokens, passwords and keys are never
   shared in the workspace. Write them as `{{variables}}` everywhere (auth fields too, e.g.
   `"token": "{{token}}"`) and declare those variables with `secret: true` and an empty value
   (collection or environment, `integration_save_environment`). Each member types their own value
   in the web app, never in the chat. Literal credentials saved in a collection are moved to the
   saving user's private vault and blanked in the shared document.
5. Reads (`integration_get_collection`, `integration_list_environments`) never return secret
   values: `personalSecrets` lists the refs the user has set (`var:<key>`,
   `auth:<owner>:<field>`, `proxy:<field>`, `cert:<index>:<field>`) and secret variables show
   `hasValue`. `integration_clear_personal_secret` removes one of the user's own values.

Existing collections: `integration_import { content }` reads Postman v2.1, Insomnia exports,
OpenAPI 3 / Swagger 2 (JSON or YAML) and the ADK format. `integration_export { format }` writes
`postman`, `insomnia`, `bruno` (the .bru files) or `adk`.

CI pipeline: pick a repository and branch with `integration_list_repositories` and
`integration_list_branches`, save them in the collection's `ci` settings (`repository`, `tool`:
`bruno`, `postman` or `insomnia`, optional `environmentId`) with `integration_save_collection`,
check the files with `integration_preview_pipeline`, then, once the user agrees, commit them with
`integration_publish_pipeline`. Tell the user which CI secrets to create.

## Run and read results

- `integration_run { collectionId, environmentId?, itemIds?, target, iterations?, data?, delayMs? }`,
  then poll `integration_get_run` until the status is `passed`, `failed` or `error`. Runs use
  the requesting user's own credentials. `data` is a list of rows (one iteration each, columns as
  `{{variables}}`).
- Captures and scripts leave runtime variables and cookies for the user's next sends (personal):
  `integration_get_runtime` shows them, `integration_clear_runtime` resets them, and
  `useRuntime: false` runs from a clean state.
- Report each failed request with its status, failed assertions and the start of the response.
  Separate API bugs from test problems (wrong expectation, missing variable, environment down).
- A remote run cannot reach `localhost`: use `target: "local"` and ask the user to keep
  `devkit runner` open.

## Load and performance tests

1. `load_profiles { vus, durationSec }` shows the default stages of each type: smoke, load, stress,
   spike, soak, breakpoint, custom. Choose with the user what question the test answers
   (expected peak? breaking point? recovery? leaks over time?).
2. `load_prepare_generation { collectionId, sources?, instructions? }` (host) or `load_generate`
   (server), or write the scenario and save it with `load_save_scenario`. Weight the requests like
   real traffic; set thresholds from the SLAs (otherwise errorRate < 0.01 and p95 < 500 ms).
3. **Load is real traffic.** Before `load_run`, confirm the user is allowed to load that system
   (never production without explicit approval) and pass `authorized: true`. Remote runs allow up to
   200 virtual users for 15 minutes; larger tests run locally or with the k6 export
   (`load_export_k6`).
4. `load_get_run` returns latency percentiles, requests per second, error rate, status codes,
   thresholds and a per-second timeline. Explain where latency or errors started to grow and at how
   many virtual users.
