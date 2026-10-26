import { z } from 'zod';
import { segment } from '../../api/http-client.js';
import type { McpModule } from '../../core/registry.js';
import { defineTool, json } from '../../core/tool.js';
import { id } from '../shared.js';

// Integration tests (collections of requests with assertions, exportable to Postman, Insomnia
// and Bruno) and overload tests (load scenarios replaying those requests). Runs execute on the
// ADK workers (target "remote") or on the user's computer through `devkit runner` ("local").

const collectionId = id('Collection id (from integration_list_collections).');
const environmentId = id('Environment id (from integration_list_environments).');
const scenarioId = id('Load scenario id (from load_list_scenarios).');
const runId = id('Run id.');
const target = z
  .enum(['remote', 'local'])
  .default('remote')
  .describe(
    '"remote" runs on the ADK workers (public URLs only); "local" runs on the user\'s computer, which must have `devkit runner` open (localhost and internal networks).',
  );
const sources = z
  .array(
    z.object({
      type: z.enum(['testPlan', 'testSuite', 'brain', 'spec', 'pbi']),
      id: z.string().trim().min(1).max(500),
    }),
  )
  .max(20)
  .default([])
  .describe(
    'ADK items to generate from: saved test plans or suites (testplans_list), Brain pages (brain_list_documents pageId), specs (spec_list), PBIs (pbi_list).',
  );
const generationFields = {
  sources,
  instructions: z
    .string()
    .max(40_000)
    .optional()
    .describe('What to test, an API description, or the text of a document.'),
  baseUrl: z.string().trim().max(2_000).optional().describe('Base URL of the system under test.'),
};

export const integrationTestsModule: McpModule = {
  toolset: 'integrationtests',
  tools: [
    defineTool({
      name: 'integration_list_collections',
      title: 'List API test collections',
      description:
        'Lists the integration test collections of the workspace (name, number of requests, where they came from).',
      toolset: 'integrationtests',
      access: 'read',
      routes: ['GET /integration-tests/collections'],
      input: {},
      run: async (_, { api }) =>
        json(await api.request({ method: 'GET', path: '/integration-tests/collections' })),
    }),
    defineTool({
      name: 'integration_list_dynamic_values',
      title: 'List API test dynamic values',
      description:
        'Lists the `{{$randomFullName}}`-style helpers that URLs, headers and bodies of collection requests can use, each with a fresh sample value.',
      toolset: 'integrationtests',
      access: 'read',
      routes: ['GET /integration-tests/dynamic-values'],
      input: {},
      run: async (_, { api }) =>
        json(await api.request({ method: 'GET', path: '/integration-tests/dynamic-values' })),
    }),
    defineTool({
      name: 'integration_get_collection',
      title: 'Get API test collection',
      description:
        'Returns a collection with its folders, requests, assertions, captures and variables (secret values are never returned).',
      toolset: 'integrationtests',
      access: 'read',
      routes: ['GET /integration-tests/collections/:id'],
      input: { collectionId },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'GET',
            path: `/integration-tests/collections/${segment(input.collectionId)}`,
          }),
        ),
    }),
    defineTool({
      name: 'integration_save_collection',
      title: 'Save API test collection',
      description:
        'Creates a collection, or replaces one when collectionId is given. The collection uses the ADK format returned by integration_prepare_generation (ids are optional). Secret variables saved with an empty value keep their current value.',
      toolset: 'integrationtests',
      access: 'write',
      routes: ['POST /integration-tests/collections', 'PUT /integration-tests/collections/:id'],
      input: {
        collectionId: collectionId.optional(),
        collection: z
          .record(z.string(), z.unknown())
          .describe('{ name, description?, variables, auth, items: [folders and requests] }'),
      },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: input.collectionId ? 'PUT' : 'POST',
            path: input.collectionId
              ? `/integration-tests/collections/${segment(input.collectionId)}`
              : '/integration-tests/collections',
            body: input.collection,
          }),
        ),
    }),
    defineTool({
      name: 'integration_delete_collection',
      title: 'Delete API test collection',
      description: 'Deletes a collection and the load scenarios built on it. Confirm first.',
      toolset: 'integrationtests',
      access: 'destructive',
      routes: ['DELETE /integration-tests/collections/:id'],
      input: { collectionId },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'DELETE',
            path: `/integration-tests/collections/${segment(input.collectionId)}`,
          }),
        ),
    }),
    defineTool({
      name: 'integration_import',
      title: 'Import API collection',
      description:
        'Imports a collection file: ADK (adk-api-collection), Postman v2.1, Insomnia export or OpenAPI 3 / Swagger 2 (JSON or YAML). The format is detected when omitted.',
      toolset: 'integrationtests',
      access: 'write',
      routes: ['POST /integration-tests/collections/import'],
      input: {
        content: z.string().min(1).max(5_000_000).describe('The file content.'),
        format: z.enum(['adk', 'postman', 'insomnia', 'openapi']).optional(),
        name: z.string().trim().min(1).max(200).optional().describe('Name for the new collection.'),
      },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'POST',
            path: '/integration-tests/collections/import',
            body: input,
          }),
        ),
    }),
    defineTool({
      name: 'integration_export',
      title: 'Export API collection',
      description:
        'Exports a collection for other tools: adk, postman (v2.1, also imported by Bruno and Insomnia), insomnia (v4) or bruno (returns the .bru files to write into a folder). Secret values are left empty.',
      toolset: 'integrationtests',
      access: 'read',
      routes: ['GET /integration-tests/collections/:id/export'],
      input: {
        collectionId,
        format: z.enum(['adk', 'postman', 'insomnia', 'bruno']).default('postman'),
        environmentIds: z
          .array(z.string().trim().min(1).max(100))
          .max(20)
          .default([])
          .describe('Environments to include (ADK and Bruno formats).'),
      },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'GET',
            path: `/integration-tests/collections/${segment(input.collectionId)}/export`,
            query: {
              format: input.format,
              ...(input.environmentIds.length
                ? { environmentIds: input.environmentIds.join(',') }
                : {}),
              ...(input.format === 'bruno' ? { as: 'files' } : {}),
            },
          }),
        ),
    }),
    defineTool({
      name: 'integration_list_environments',
      title: 'List API test environments',
      description:
        'Lists the environments (variables such as base URLs and credentials); secret values are never returned.',
      toolset: 'integrationtests',
      access: 'read',
      routes: ['GET /integration-tests/environments'],
      input: {},
      run: async (_, { api }) =>
        json(await api.request({ method: 'GET', path: '/integration-tests/environments' })),
    }),
    defineTool({
      name: 'integration_save_environment',
      title: 'Save API test environment',
      description:
        'Creates an environment, or replaces one when environmentId is given. Mark credentials with secret: true; ask the user to type secret values in the web app rather than through the chat.',
      toolset: 'integrationtests',
      access: 'write',
      routes: ['POST /integration-tests/environments', 'PUT /integration-tests/environments/:id'],
      input: {
        environmentId: environmentId.optional(),
        name: z.string().trim().min(1).max(200),
        variables: z
          .array(
            z.object({
              key: z.string().max(500),
              value: z.string().max(20_000),
              enabled: z.boolean().optional(),
              secret: z.boolean().optional(),
            }),
          )
          .max(200)
          .default([]),
      },
      run: async ({ environmentId: target, ...body }, { api }) =>
        json(
          await api.request({
            method: target ? 'PUT' : 'POST',
            path: target
              ? `/integration-tests/environments/${segment(target)}`
              : '/integration-tests/environments',
            body,
          }),
        ),
    }),
    defineTool({
      name: 'integration_delete_environment',
      title: 'Delete API test environment',
      description: 'Deletes an environment. Confirm first.',
      toolset: 'integrationtests',
      access: 'destructive',
      routes: ['DELETE /integration-tests/environments/:id'],
      input: { environmentId },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'DELETE',
            path: `/integration-tests/environments/${segment(input.environmentId)}`,
          }),
        ),
    }),
    defineTool({
      name: 'integration_prepare_generation',
      title: 'Write API tests (host model)',
      description:
        'Loads the sources (test plans, Brain pages, specs, PBIs) with the instruction and the ADK collection format, so you write the integration tests yourself and save them with integration_save_collection.',
      toolset: 'integrationtests',
      access: 'write',
      execution: 'host',
      routes: ['POST /integration-tests/generate/prepare'],
      input: generationFields,
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'POST',
            path: '/integration-tests/generate/prepare',
            body: input,
          }),
        ),
    }),
    defineTool({
      name: 'integration_generate',
      title: 'Generate API tests (server model)',
      description:
        "Generates and saves a collection with the workspace's AI provider from the sources.",
      toolset: 'integrationtests',
      access: 'write',
      execution: 'server',
      routes: ['POST /integration-tests/generate'],
      input: {
        ...generationFields,
        llmProvider: z.string().trim().min(1).optional().describe('LLM integration provider id.'),
      },
      run: async (input, { api }) =>
        json(
          await api.request({ method: 'POST', path: '/integration-tests/generate', body: input }),
        ),
    }),
    defineTool({
      name: 'integration_run',
      title: 'Run API tests',
      description:
        'Runs a collection (or some folders/requests) with an environment. Requests run in order and share captured variables. Poll integration_get_run for the result.',
      toolset: 'integrationtests',
      access: 'write',
      routes: ['POST /integration-tests/runs'],
      input: {
        collectionId,
        environmentId: environmentId.optional(),
        itemIds: z
          .array(z.string().trim().min(1).max(100))
          .max(500)
          .default([])
          .describe('Folder or request ids to run; empty runs everything.'),
        target,
        bail: z.boolean().default(false).describe('Stop at the first failing request.'),
      },
      run: async (input, { api }) =>
        json(await api.request({ method: 'POST', path: '/integration-tests/runs', body: input })),
    }),
    defineTool({
      name: 'integration_list_runs',
      title: 'List API test runs',
      description: 'Lists integration runs (newest first) with their totals.',
      toolset: 'integrationtests',
      access: 'read',
      routes: ['GET /integration-tests/runs'],
      input: {
        collectionId: collectionId.optional(),
        limit: z.number().int().min(1).max(200).default(20),
      },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'GET',
            path: '/integration-tests/runs',
            query: {
              limit: String(input.limit),
              ...(input.collectionId ? { collectionId: input.collectionId } : {}),
            },
          }),
        ),
    }),
    defineTool({
      name: 'integration_get_run',
      title: 'Get API test run',
      description:
        'Returns a run with the result of every request: status, duration, failed assertions and the start of the response.',
      toolset: 'integrationtests',
      access: 'read',
      routes: ['GET /integration-tests/runs/:id'],
      input: { runId },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'GET',
            path: `/integration-tests/runs/${segment(input.runId)}`,
          }),
        ),
    }),
    defineTool({
      name: 'integration_cancel_run',
      title: 'Cancel API test run',
      description: 'Cancels a queued or running integration run.',
      toolset: 'integrationtests',
      access: 'write',
      routes: ['POST /integration-tests/runs/:id/cancel'],
      input: { runId },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'POST',
            path: `/integration-tests/runs/${segment(input.runId)}/cancel`,
          }),
        ),
    }),
    defineTool({
      name: 'integration_delete_run',
      title: 'Delete API test run',
      description: 'Deletes a finished integration run from the history.',
      toolset: 'integrationtests',
      access: 'destructive',
      routes: ['DELETE /integration-tests/runs/:id'],
      input: { runId },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'DELETE',
            path: `/integration-tests/runs/${segment(input.runId)}`,
          }),
        ),
    }),
  ],
};

const scenarioShape =
  '{ name, description?, collectionId, environmentId?, requests: [{ requestId, weight }], profile: smoke|load|stress|spike|soak|breakpoint|custom, stages: [{ durationSec, targetVus }], thinkTimeMs, thresholds: [{ metric: avg|p50|p90|p95|p99|max|errorRate|rps|checksRate, operator: lt|lte|gt|gte, value, abortOnFail? }], timeoutMs? }';

export const loadTestsModule: McpModule = {
  toolset: 'loadtests',
  tools: [
    defineTool({
      name: 'load_profiles',
      title: 'Load test types',
      description:
        'Returns the default stages and thresholds of every test type (smoke, load, stress, spike, soak, breakpoint, custom) for a peak of virtual users and a duration.',
      toolset: 'loadtests',
      access: 'read',
      routes: ['GET /load-tests/profiles'],
      input: {
        vus: z.number().int().min(1).max(2_000).default(20),
        durationSec: z.number().int().min(10).max(14_400).default(300),
      },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'GET',
            path: '/load-tests/profiles',
            query: { vus: String(input.vus), durationSec: String(input.durationSec) },
          }),
        ),
    }),
    defineTool({
      name: 'load_list_scenarios',
      title: 'List load scenarios',
      description: 'Lists the load test scenarios of the workspace.',
      toolset: 'loadtests',
      access: 'read',
      routes: ['GET /load-tests/scenarios'],
      input: {},
      run: async (_, { api }) =>
        json(await api.request({ method: 'GET', path: '/load-tests/scenarios' })),
    }),
    defineTool({
      name: 'load_get_scenario',
      title: 'Get load scenario',
      description:
        'Returns a load scenario: requests and weights, stages, think time and thresholds.',
      toolset: 'loadtests',
      access: 'read',
      routes: ['GET /load-tests/scenarios/:id'],
      input: { scenarioId },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'GET',
            path: `/load-tests/scenarios/${segment(input.scenarioId)}`,
          }),
        ),
    }),
    defineTool({
      name: 'load_save_scenario',
      title: 'Save load scenario',
      description: `Creates a load scenario, or replaces one when scenarioId is given. Shape: ${scenarioShape}. Requests come from a collection (integration_get_collection).`,
      toolset: 'loadtests',
      access: 'write',
      routes: ['POST /load-tests/scenarios', 'PUT /load-tests/scenarios/:id'],
      input: {
        scenarioId: scenarioId.optional(),
        scenario: z.record(z.string(), z.unknown()),
      },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: input.scenarioId ? 'PUT' : 'POST',
            path: input.scenarioId
              ? `/load-tests/scenarios/${segment(input.scenarioId)}`
              : '/load-tests/scenarios',
            body: input.scenario,
          }),
        ),
    }),
    defineTool({
      name: 'load_delete_scenario',
      title: 'Delete load scenario',
      description: 'Deletes a load scenario. Confirm first.',
      toolset: 'loadtests',
      access: 'destructive',
      routes: ['DELETE /load-tests/scenarios/:id'],
      input: { scenarioId },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'DELETE',
            path: `/load-tests/scenarios/${segment(input.scenarioId)}`,
          }),
        ),
    }),
    defineTool({
      name: 'load_export_k6',
      title: 'Export load scenario to k6',
      description:
        'Returns the scenario as a k6 script (same stages, thresholds and weighted requests). Secret variables are read from the environment: k6 run -e name=value.',
      toolset: 'loadtests',
      access: 'read',
      routes: ['GET /load-tests/scenarios/:id/k6'],
      input: { scenarioId },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'GET',
            path: `/load-tests/scenarios/${segment(input.scenarioId)}/k6`,
          }),
        ),
    }),
    defineTool({
      name: 'load_prepare_generation',
      title: 'Design a load test (host model)',
      description:
        'Loads the sources and the requests of a collection with the instruction to design a load scenario, so you write it yourself and save it with load_save_scenario.',
      toolset: 'loadtests',
      access: 'write',
      execution: 'host',
      routes: ['POST /load-tests/generate/prepare'],
      input: { collectionId, ...generationFields },
      run: async (input, { api }) =>
        json(
          await api.request({ method: 'POST', path: '/load-tests/generate/prepare', body: input }),
        ),
    }),
    defineTool({
      name: 'load_generate',
      title: 'Design a load test (server model)',
      description: "Designs and saves a load scenario with the workspace's AI provider.",
      toolset: 'loadtests',
      access: 'write',
      execution: 'server',
      routes: ['POST /load-tests/generate'],
      input: {
        collectionId,
        ...generationFields,
        llmProvider: z.string().trim().min(1).optional().describe('LLM integration provider id.'),
      },
      run: async (input, { api }) =>
        json(await api.request({ method: 'POST', path: '/load-tests/generate', body: input })),
    }),
    defineTool({
      name: 'load_run',
      title: 'Run load test',
      description:
        'Starts a load test. Load tests put real traffic on the target: ask the user to confirm they are allowed to load that system and pass authorized: true. Remote runs allow up to 200 virtual users for 15 minutes. Poll load_get_run for metrics.',
      toolset: 'loadtests',
      access: 'write',
      routes: ['POST /load-tests/runs'],
      input: {
        scenarioId,
        target,
        authorized: z
          .boolean()
          .describe('The user confirmed they may put this load on the target system.'),
      },
      run: async (input, { api }) =>
        json(await api.request({ method: 'POST', path: '/load-tests/runs', body: input })),
    }),
    defineTool({
      name: 'load_list_runs',
      title: 'List load test runs',
      description: 'Lists load runs (newest first) with their summary metrics.',
      toolset: 'loadtests',
      access: 'read',
      routes: ['GET /load-tests/runs'],
      input: {
        scenarioId: scenarioId.optional(),
        limit: z.number().int().min(1).max(200).default(20),
      },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'GET',
            path: '/load-tests/runs',
            query: {
              limit: String(input.limit),
              ...(input.scenarioId ? { scenarioId: input.scenarioId } : {}),
            },
          }),
        ),
    }),
    defineTool({
      name: 'load_get_run',
      title: 'Get load test run',
      description:
        'Returns a load run: latency percentiles, requests per second, error rate, status codes, thresholds and the per-second timeline.',
      toolset: 'loadtests',
      access: 'read',
      routes: ['GET /load-tests/runs/:id'],
      input: { runId },
      run: async (input, { api }) =>
        json(
          await api.request({ method: 'GET', path: `/load-tests/runs/${segment(input.runId)}` }),
        ),
    }),
    defineTool({
      name: 'load_cancel_run',
      title: 'Cancel load test run',
      description: 'Stops a queued or running load test.',
      toolset: 'loadtests',
      access: 'write',
      routes: ['POST /load-tests/runs/:id/cancel'],
      input: { runId },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'POST',
            path: `/load-tests/runs/${segment(input.runId)}/cancel`,
          }),
        ),
    }),
    defineTool({
      name: 'load_delete_run',
      title: 'Delete load test run',
      description: 'Deletes a finished load run from the history.',
      toolset: 'loadtests',
      access: 'destructive',
      routes: ['DELETE /load-tests/runs/:id'],
      input: { runId },
      run: async (input, { api }) =>
        json(
          await api.request({ method: 'DELETE', path: `/load-tests/runs/${segment(input.runId)}` }),
        ),
    }),
  ],
};
