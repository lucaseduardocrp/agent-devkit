import { z } from 'zod';
import type { AdkApi } from '../../api/http-client.js';
import type { McpModule } from '../../core/registry.js';
import { defineTool, json } from '../../core/tool.js';
import { UNTRUSTED_CONTENT_RULE, id, untrusted } from '../shared.js';
import {
  caseSelection,
  QUEUE_NOTICE,
  caseReference,
  describeStep,
  guardLinkedSteps,
  guardRun,
  guardTest,
  reportingTarget,
  runId,
  runPath,
  testId,
  testPath,
  type ExternalCaseDto,
  type RunDto,
  type TestDto,
} from './common.js';
import { testManagementTools } from './test-management.js';
import { localOrigin, quickTunnelCommand } from './cloudflare-tunnel.js';

const provider = z
  .enum(['github', 'azure_devops'])
  .describe('Where the Playwright scripts live: github or azure_devops.');
const SECRET_NOTICE =
  'Values typed in chat are sent to the model provider; prefer a dedicated test account. The password is stored encrypted and never returned.';

/** Localhost is only reachable when the user's own computer runs the browser. */
function requireReachableUrl(baseUrl: string, executionTarget?: 'remote' | 'local'): string {
  if (executionTarget === 'local') return baseUrl;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return baseUrl;
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) return baseUrl;
  throw new Error(
    'The ADK MCP server and E2E worker run on Railway, so localhost cannot reach your computer. Either set executionTarget "local" so the user\'s `devkit runner` runs the browser on their computer, or run e2e_tunnel_setup and pass the public HTTPS URL as baseUrl.',
  );
}

const executionTarget = z
  .enum(['remote', 'local'])
  .describe(
    'remote: the ADK worker runs the browser (the app must be publicly reachable). local: the browser runs on the computer of the user who starts the run, through `devkit runner` (outbound HTTPS only, no tunnel), so localhost URLs work; AI planning, healing and results stay in ADK.',
  );

/** Settings shared by creating and editing a run. */
const runSettings = {
  name: z.string().trim().min(1).max(120).describe('Run name, e.g. "Checkout flow".'),
  agentId: id('Agent that plans and writes the tests (see agents_list).'),
  mode: z
    .enum(['frontend', 'backend'])
    .default('frontend')
    .describe('frontend drives the UI in a browser; backend exercises HTTP endpoints.'),
  scope: z
    .enum(['codebase', 'diff'])
    .default('codebase')
    .describe('codebase tests the whole product; diff focuses on the changes in "diff".'),
  baseUrl: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe(
      'Application URL. With executionTarget "local" it can be localhost, e.g. http://localhost:8014; otherwise a public URL such as https://staging.example.com or a Cloudflare Tunnel hostname (see e2e_tunnel_setup).',
    ),
  localOrigin: z
    .string()
    .trim()
    .max(500)
    .optional()
    .describe(
      'Original HTTP localhost origin, e.g. http://localhost:8014, when baseUrl is a tunnel. Keeps the browser origin local so app CORS and sign-in rules continue to work.',
    ),
  executionTarget: executionTarget.optional(),
  path: z.string().trim().max(500).optional().describe('Path where the flow starts, e.g. /login.'),
  username: z.string().trim().max(320).optional().describe('Login used by the tests.'),
  password: z.string().max(500).optional().describe(`Password for "username". ${SECRET_NOTICE}`),
  accessClientId: z
    .string()
    .trim()
    .max(320)
    .optional()
    .describe('Cloudflare Access service token Client ID for a protected Named Tunnel.'),
  accessClientSecret: z
    .string()
    .trim()
    .max(500)
    .optional()
    .describe(`Cloudflare Access service token Client Secret. ${SECRET_NOTICE}`),
  clearAccessServiceToken: z
    .boolean()
    .optional()
    .describe('Remove a saved Cloudflare Access service token when editing.'),
  prd: z
    .string()
    .trim()
    .min(1)
    .max(500_000)
    .describe('Product document: features, flows and business rules. A draft is enough.'),
  prdFileNames: z.array(z.string().trim().min(1).max(255)).max(20).optional(),
  diff: z.string().max(500_000).optional().describe('Unified diff, required when scope is diff.'),
  instructions: z
    .string()
    .trim()
    .max(5_000)
    .optional()
    .describe('Extra guidance, e.g. "prioritize the voting flow and skip the admin area".'),
  repository: z
    .object({
      provider,
      id: id('Repository id from e2e_list_repositories.'),
      branch: z.string().trim().min(1).max(250).describe('Branch from e2e_list_branches.'),
      path: z
        .string()
        .trim()
        .max(300)
        .default('tests/e2e')
        .describe('Folder for the generated specs.'),
    })
    .describe('Where the generated Playwright scripts are committed.'),
};

interface BriefDto {
  readonly agent: { readonly instructions: string };
  readonly documents: {
    readonly prd: string;
    readonly diff: string | null;
    readonly instructions: string | null;
    readonly standardizedPrd: string | null;
  };
  readonly snapshot: { readonly status: 'capturing' | 'failed' | 'ready'; readonly data?: unknown };
  readonly rules: Record<string, unknown>;
  readonly existingTests?: readonly TestDto[];
}

/** How the host turns the brief into a plan; the ADK worker only runs the scripts. */
const HOST_RULES = [
  'You plan and write the scripts: the ADK worker only executes them with Playwright and records videos. Without a workspace LLM failures come back without AI analysis: read the error and logs with e2e_get_test and fix the spec with e2e_update_script.',
  'Test case N (1-based, in the order you send them) gets code TC00N; start each test name with it, e.g. "TC001 - Valid login".',
  'Credentials reach scripts only as process.env.E2E_USERNAME and process.env.E2E_PASSWORD; never write them in a spec or in chat.',
  'Base locators on the snapshot (labels, placeholders, button texts) and keep every spec independent.',
  'Existing tests with an externalCase automate a case kept on a test management platform (Azure Test Plans, TestRail, Xray); its steps are listed in "steps". Plan exactly those tests (one spec per case, no extra cases), write exactly one top-level await test.step(...) per listed step, in the same order and named as rules.script says, assert the expected result inside it, and send the same externalCase back for that test in e2e_save_plan. Each top-level step becomes the step result and screenshot published to the platform.',
  'After e2e_save_plan poll e2e_get until the run finishes. With reporting.autoPublish the results are then published to the platform automatically; otherwise call e2e_publish_run. Poll e2e_get until lastReport.status is no longer "publishing".',
];

const caseKey = (item: { provider: string; caseId: string }) => `${item.provider}:${item.caseId}`;

/**
 * The host sends a linked case back by reference: ADK receives it exactly as imported (title and
 * steps from the platform), never the untrusted-wrapped text the host was shown.
 */
async function linkedCases(api: AdkApi, value: string): Promise<Map<string, ExternalCaseDto>> {
  const { creation } = await api.request<{ creation: RunDto }>({
    method: 'GET',
    path: runPath(value),
  });
  return new Map(
    (creation.tests ?? []).flatMap((test) =>
      test.externalCase ? [[caseKey(test.externalCase), test.externalCase] as const] : [],
    ),
  );
}

function resolveCase(
  known: ReadonlyMap<string, ExternalCaseDto>,
  reference: z.output<typeof caseReference>,
): ExternalCaseDto {
  const item = known.get(caseKey(reference));
  if (!item)
    throw new Error(
      `Test case ${caseKey(reference)} is not linked to this run. Import it with e2e_import_cases (or link a test with e2e_link_case), call e2e_prepare and send the externalCase it returns.`,
    );
  return item;
}

export const e2eModule: McpModule = {
  toolset: 'e2e',
  tools: [
    defineTool({
      name: 'e2e_tunnel_setup',
      title: 'Connect a local app to remote E2E',
      description:
        'Returns the command the user must run on the computer hosting their application. The ADK MCP server and Playwright worker run on Railway and cannot start a process on that computer. `devkit tunnel` opens one authenticated tunnel to a local gateway, so the frontend and the other localhost services it calls from the browser (APIs, SSO) are reachable. It prints the public URL and a session key to use with e2e_create or e2e_update; a configured Named Tunnel hostname works too.',
      toolset: 'e2e',
      access: 'read',
      routes: [],
      input: {
        localUrl: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .describe("URL on the user's computer, e.g. http://localhost:5173."),
      },
      run: ({ localUrl }) => {
        const origin = localOrigin(localUrl);
        return Promise.resolve(
          json({
            localUrl: origin,
            command: `devkit tunnel --url ${origin}`,
            singlePortCommand: quickTunnelCommand(origin),
            next: 'Ask the user to run `command` on the computer hosting the application (it needs the devkit CLI and cloudflared). It prints Base URL, Original local address, Access Client ID and Access Client Secret: use them as baseUrl, localOrigin (frontend tests), accessClientId and accessClientSecret in e2e_check_tunnel and e2e_create/e2e_update. The worker then routes browser requests for any localhost port (backend APIs, local SSO) through the same tunnel. Suggest entering the secret in the web form instead of chat. `singlePortCommand` needs only cloudflared but exposes a single port, so calls to other localhost services fail. Keep the terminal open until E2E finishes. For a Named Tunnel, use its configured public hostname instead.',
          }),
        );
      },
    }),
    defineTool({
      name: 'e2e_check_tunnel',
      title: 'Check tunnel from Railway',
      description:
        'Checks whether the public HTTPS URL of a Quick or Named Cloudflare Tunnel can be reached from the ADK API on Railway before creating an E2E run. Authentication, rejected Host headers and origin errors are reported separately. Keep the local connector running during the tests.',
      toolset: 'e2e',
      access: 'write',
      openWorld: true,
      routes: ['POST /e2e/tunnel/check'],
      input: {
        url: z.string().trim().url().max(500).describe('Public HTTPS tunnel URL, not localhost.'),
        creationId: z
          .string()
          .trim()
          .max(100)
          .optional()
          .describe('Existing run whose saved Access token should be used for the same URL.'),
        accessClientId: z.string().trim().max(320).optional(),
        accessClientSecret: z.string().trim().max(500).optional(),
      },
      run: async ({ url, creationId, accessClientId, accessClientSecret }, { api }) =>
        json(
          await api.request({
            method: 'POST',
            path: '/e2e/tunnel/check',
            body: { url, creationId, accessClientId, accessClientSecret },
          }),
        ),
    }),
    defineTool({
      name: 'e2e_list_repositories',
      openWorld: true,
      title: 'E2E script repositories',
      description:
        'Lists the GitHub and Azure DevOps repositories the workspace integrations can access, to choose where generated Playwright scripts are stored. Warnings explain providers that are missing or unreachable.',
      toolset: 'e2e',
      access: 'read',
      routes: ['GET /e2e/repositories'],
      input: {
        search: z
          .string()
          .trim()
          .max(200)
          .optional()
          .describe('Case-insensitive filter on the repository name.'),
      },
      run: async ({ search }, { api }) => {
        const result = await api.request<{
          repositories: { name: string }[];
          warnings: unknown[];
        }>({ method: 'GET', path: '/e2e/repositories' });
        const query = search?.toLowerCase();
        return json({
          ...result,
          repositories: query
            ? result.repositories.filter((repo) => repo.name.toLowerCase().includes(query))
            : result.repositories,
        });
      },
    }),
    defineTool({
      name: 'e2e_list_branches',
      openWorld: true,
      title: 'E2E repository branches',
      description: 'Lists the branches of a repository returned by e2e_list_repositories.',
      toolset: 'e2e',
      access: 'read',
      routes: ['GET /e2e/repositories/branches'],
      input: {
        provider,
        repositoryId: id('Repository id from e2e_list_repositories (not its name).'),
      },
      run: async (query, { api }) =>
        json(await api.request({ method: 'GET', path: '/e2e/repositories/branches', query })),
    }),
    defineTool({
      name: 'e2e_list',
      title: 'List E2E runs',
      description:
        'Lists the E2E runs of the active workspace with status, pass count, reporting target, last publication and a summary of each test case.',
      toolset: 'e2e',
      access: 'read',
      routes: ['GET /e2e/creations'],
      input: {
        status: z
          .enum(['draft', 'queued', 'planning', 'running', 'completed', 'failed', 'cancelled'])
          .optional()
          .describe('Only runs with this status.'),
        search: z.string().trim().max(200).optional().describe('Filter on the run name or URL.'),
      },
      run: async ({ status, search }, { api }) => {
        const { creations } = await api.request<{
          creations: (RunDto & { status: string; name: string; baseUrl: string })[];
        }>({ method: 'GET', path: '/e2e/creations' });
        const query = search?.toLowerCase();
        return json({
          creations: creations
            .filter(
              (run) =>
                (!status || run.status === status) &&
                (!query || `${run.name} ${run.baseUrl}`.toLowerCase().includes(query)),
            )
            .map(guardRun),
        });
      },
    }),
    defineTool({
      name: 'e2e_get',
      title: 'Get E2E run',
      description:
        'Returns an E2E run with its settings, PRD summary, reporting target, last publication to the test management platform (lastReport) and every test case (status, steps, linked externalCase, per-step results, error, AI analysis, verdict, duration).',
      toolset: 'e2e',
      access: 'read',
      routes: ['GET /e2e/creations/:id'],
      input: { runId },
      run: async ({ runId: value }, { api }) => {
        const { creation } = await api.request<{ creation: RunDto }>({
          method: 'GET',
          path: runPath(value),
        });
        return json({ creation: guardRun(creation) });
      },
    }),
    defineTool({
      name: 'e2e_create',
      openWorld: true,
      title: 'Create E2E run',
      description: `Creates an E2E run that tests the application with Playwright scripts committed to the chosen repository, runs each test on the ADK worker and records a video. With planning "host" (default, no API key needed) the run waits as a draft: call e2e_prepare, write the test cases and specs yourself and save them with e2e_save_plan. With planning "server" the workspace LLM plans and writes everything (needs an LLM integration in ADK). To automate cases kept on a test management platform (Azure Test Plans, TestRail, Xray) pass importCases (prd becomes optional): each case becomes a test whose spec has one top-level test.step per case step, and the results with step screenshots are published back to the same plan/suite unless reporting says otherwise. To automate test cases already saved in ADK (a local suite, Test Plan or chosen cases, e.g. imported with testplans_import_cases) pass savedCases instead. ${QUEUE_NOTICE} For an app on the user's localhost, prefer executionTarget "local" (the user's devkit runner runs the browser on their computer; check e2e_list_runners); otherwise call e2e_tunnel_setup and pass the tunnel URL as baseUrl and the localhost origin as localOrigin. ${SECRET_NOTICE}`,
      toolset: 'e2e',
      access: 'write',
      routes: ['POST /e2e/creations'],
      input: {
        ...runSettings,
        prd: runSettings.prd
          .optional()
          .describe(
            'Product document: features, flows and business rules. A draft is enough. Optional with importCases.',
          ),
        importCases: z
          .object(caseSelection)
          .optional()
          .describe(
            'Test management cases the run automates instead of planning tests from the PRD (see e2e_test_management_providers and e2e_list_remote_cases).',
          ),
        savedCases: z
          .object({
            suiteId: z
              .string()
              .trim()
              .min(1)
              .max(200)
              .optional()
              .describe('Local suite (testplans_list_suites); its child suites are included.'),
            planId: z
              .string()
              .trim()
              .min(1)
              .max(200)
              .optional()
              .describe('Saved Test Plan id (testplans_list).'),
            caseIds: z
              .array(z.string().trim().min(1).max(200))
              .min(1)
              .max(100)
              .optional()
              .describe('Only these cases (metadata.caseId from testplans_get).'),
          })
          .optional()
          .describe(
            'Test cases already saved in ADK (written there or imported with testplans_import_cases) that the run automates instead of planning tests from the PRD; give suiteId or planId. Imported cases are read again from their platform and the results are published back to it. Not with importCases.',
          ),
        reporting: reportingTarget
          .nullable()
          .optional()
          .describe(
            'Where results are published. Defaults to the importCases platform, plan and suite with autoPublish on; null disables reporting.',
          ),
        planning: z
          .enum(['host', 'server'])
          .default('host')
          .describe(
            'host: you write the plan and scripts (e2e_prepare + e2e_save_plan), no API key needed. server: the workspace LLM does it.',
          ),
      },
      run: async (body, context) => {
        if (!body.prd && !body.importCases && !body.savedCases)
          throw new Error(
            'Provide prd (the product document), importCases (test management cases) or savedCases (test cases saved in ADK) to automate.',
          );
        if (body.savedCases && !body.savedCases.suiteId && !body.savedCases.planId)
          throw new Error('savedCases needs a suiteId or a planId.');
        return json(
          await context.api.request({
            method: 'POST',
            path: '/e2e/creations',
            body: { ...body, baseUrl: requireReachableUrl(body.baseUrl, body.executionTarget) },
          }),
        );
      },
    }),
    defineTool({
      name: 'e2e_update',
      openWorld: true,
      title: 'Edit E2E run',
      description: `Replaces the settings of an idle E2E run (name, agent, URL, account, documents, repository) without running it; its tests are kept. Omit password to keep the stored one; an empty username removes the account. Changing the repository location unlinks the specs (save a new plan or run e2e_pull_scripts). Read the current values with e2e_get first. ${SECRET_NOTICE}`,
      toolset: 'e2e',
      access: 'write',
      routes: ['PUT /e2e/creations/:id'],
      input: { runId, ...runSettings },
      run: async ({ runId: value, ...body }, context) =>
        json(
          await context.api.request({
            method: 'PUT',
            path: runPath(value),
            body: { ...body, baseUrl: requireReachableUrl(body.baseUrl, body.executionTarget) },
          }),
        ),
    }),
    defineTool({
      name: 'e2e_set_execution',
      title: 'Run E2E locally or on ADK',
      description:
        'Switches an idle E2E run between the ADK worker (remote) and the computer of the user who starts it (local, through `devkit runner`). Going local, a tunnel run targets its localhost origin directly and the tunnel token is removed. Check that the user has a runner online with e2e_list_runners before running a local run.',
      toolset: 'e2e',
      access: 'write',
      routes: ['PUT /e2e/creations/:id/execution'],
      input: { runId, executionTarget },
      run: async ({ runId: value, executionTarget: target }, context) =>
        json(
          await context.api.request({
            method: 'PUT',
            path: `${runPath(value)}/execution`,
            body: { executionTarget: target },
          }),
        ),
    }),
    defineTool({
      name: 'e2e_list_runners',
      title: 'List local E2E runners',
      description:
        "Lists the signed-in user's local runners (`devkit runner` on their computers) seen in the last day, with online status. Local runs wait up to five minutes for an online runner. To connect one, the user installs the devkit CLI, runs `devkit login`, `devkit e2e setup` once (downloads Chromium) and keeps `devkit runner` open.",
      toolset: 'e2e',
      access: 'read',
      routes: ['GET /e2e/runners'],
      input: {},
      run: async (_input, context) =>
        json(await context.api.request({ method: 'GET', path: '/e2e/runners' })),
    }),
    defineTool({
      name: 'e2e_prepare',
      title: 'Prepare E2E plan (host model)',
      description:
        'Returns what you need to plan an E2E run and write its Playwright specs yourself: the run settings, product document, extra instructions, agent persona, authoring rules, limits, existing tests (with the test management case each one automates, if any) and a snapshot of the application (headings, buttons, links, fields) captured by the ADK worker. While the snapshot is "capturing", wait a few seconds and call again. Then save with e2e_save_plan.',
      toolset: 'e2e',
      access: 'write',
      execution: 'host',
      routes: ['POST /e2e/creations/:id/brief'],
      input: {
        runId,
        refresh: z
          .boolean()
          .default(false)
          .describe('Capture the application again (for example after it changed).'),
      },
      run: async ({ runId: value, refresh }, { api }) => {
        const { brief } = await api.request<{ brief: BriefDto }>({
          method: 'POST',
          path: `${runPath(value)}/brief`,
          body: { refresh },
        });
        const { status } = brief.snapshot;
        const wrap = (label: string, content: string | null) =>
          content ? untrusted(label, content) : content;
        return json({
          ...brief,
          agent: {
            ...brief.agent,
            instructions: wrap('agent-instructions', brief.agent.instructions),
          },
          documents: {
            prd: wrap('e2e-prd', brief.documents.prd),
            diff: wrap('e2e-diff', brief.documents.diff),
            instructions: wrap('e2e-instructions', brief.documents.instructions),
            standardizedPrd: wrap('e2e-prd-summary', brief.documents.standardizedPrd),
          },
          snapshot:
            status === 'ready'
              ? {
                  ...brief.snapshot,
                  data: untrusted('e2e-snapshot', JSON.stringify(brief.snapshot.data, null, 2)),
                }
              : brief.snapshot,
          existingTests: (brief.existingTests ?? []).map((test) => ({
            ...test,
            ...guardLinkedSteps(test),
          })),
          rules: { ...brief.rules, host: [UNTRUSTED_CONTENT_RULE, ...HOST_RULES] },
          next:
            status === 'ready'
              ? 'Design the test cases following rules.plan (existing tests with an externalCase are fixed: one spec per case, one top-level test.step per listed step), write one spec per case following rules.script, show the plan to the user, then call e2e_save_plan.'
              : status === 'capturing'
                ? 'The worker is capturing the application: call e2e_prepare again in a few seconds. You may draft the plan meanwhile.'
                : 'The application could not be captured (see snapshot.error): ask the user to check the URL, or write the specs from the documents alone.',
        });
      },
    }),
    defineTool({
      name: 'e2e_save_plan',
      openWorld: true,
      title: 'Save E2E plan',
      description: `Saves the test cases and Playwright specs you wrote (after e2e_prepare): commits each spec to the run folder (TC001, TC002… in the given order), replaces the run's test cases and queues them for execution. Send back the externalCase of tests that automate a test management case (from e2e_prepare existingTests) so their results keep being published there. Scripts pass the same security checks first; the run must be idle. ${QUEUE_NOTICE}`,
      toolset: 'e2e',
      access: 'write',
      routes: ['PUT /e2e/creations/:id/plan'],
      input: {
        runId,
        summary: z
          .string()
          .trim()
          .max(20_000)
          .optional()
          .describe('Standardized PRD in Markdown (product goal, main flows, key rules).'),
        tests: z
          .array(
            z.object({
              title: z.string().trim().min(1).max(200).describe('Short title, max ~80 chars.'),
              description: z
                .string()
                .trim()
                .max(2_000)
                .default('')
                .describe('One or two sentences on what is verified.'),
              priority: z.enum(['high', 'medium', 'low']).default('medium'),
              steps: z
                .array(z.string().trim().min(1).max(1_000))
                .max(200)
                .default([])
                .describe(
                  'Concrete steps including expected results. For a linked test, its case steps in order (filled from the case when empty).',
                ),
              script: z
                .string()
                .min(1)
                .max(60_000)
                .describe(
                  'Full TypeScript Playwright spec for this case; its test name starts with the case code (TC001 for the first case).',
                ),
              externalCase: caseReference
                .nullable()
                .optional()
                .describe(
                  'The externalCase of this test from e2e_prepare existingTests (provider and caseId are enough): keeps it linked to that test management case. null unlinks it.',
                ),
            }),
          )
          .min(1)
          .max(10)
          .describe('Test cases in execution order.'),
      },
      run: async ({ runId: value, tests, ...rest }, { api }) => {
        const known = tests.some((test) => test.externalCase)
          ? await linkedCases(api, value)
          : new Map<string, ExternalCaseDto>();
        const body = {
          ...rest,
          tests: tests.map(({ externalCase, ...test }) => {
            if (externalCase === undefined) return test;
            if (!externalCase) return { ...test, externalCase };
            const item = resolveCase(known, externalCase);
            return {
              ...test,
              steps: test.steps.length ? test.steps : item.steps.map(describeStep),
              externalCase: item,
            };
          }),
        };
        return json(await api.request({ method: 'PUT', path: `${runPath(value)}/plan`, body }));
      },
    }),
    defineTool({
      name: 'e2e_run',
      openWorld: true,
      title: 'Run E2E again',
      description: `Runs every test case of an E2E run again with the scripts stored in the repository. A run without test cases (for example a draft) is planned by the workspace LLM instead, which needs an API key in ADK; without one use e2e_prepare + e2e_save_plan. ${QUEUE_NOTICE}`,
      toolset: 'e2e',
      access: 'write',
      routes: ['POST /e2e/creations/:id/run'],
      input: { runId },
      run: async ({ runId: value }, { api }) =>
        json(await api.request({ method: 'POST', path: `${runPath(value)}/run` })),
    }),
    defineTool({
      name: 'e2e_cancel',
      title: 'Cancel E2E run',
      description: 'Stops a queued or running E2E run; finished tests keep their results.',
      toolset: 'e2e',
      access: 'write',
      routes: ['POST /e2e/creations/:id/cancel'],
      input: { runId },
      run: async ({ runId: value }, { api }) =>
        json(await api.request({ method: 'POST', path: `${runPath(value)}/cancel` })),
    }),
    defineTool({
      name: 'e2e_delete',
      title: 'Delete E2E run',
      description:
        'Deletes an E2E run, its test cases and recorded videos (stopping it first if active). Scripts already committed to the repository are kept.',
      toolset: 'e2e',
      access: 'destructive',
      routes: ['DELETE /e2e/creations/:id'],
      input: { runId },
      run: async ({ runId: value }, { api }) => {
        await api.request({ method: 'DELETE', path: runPath(value) });
        return json({ deleted: true, runId: value });
      },
    }),
    defineTool({
      name: 'e2e_pull_scripts',
      openWorld: true,
      title: 'Sync E2E scripts',
      description:
        'Reads the run folder in the repository and links spec files changed or added there (for example edited by a developer) to the run, so the next execution uses them.',
      toolset: 'e2e',
      access: 'write',
      routes: ['POST /e2e/creations/:id/pull'],
      input: { runId },
      run: async ({ runId: value }, { api }) =>
        json(await api.request({ method: 'POST', path: `${runPath(value)}/pull` })),
    }),
    defineTool({
      name: 'e2e_get_test',
      title: 'Get E2E test case',
      description:
        'Returns one test case with its description, steps, linked test management case, status, per-step results (one per top-level test.step, with hasScreenshot), error, Playwright logs, AI failure analysis and verdict (app_bug, test_issue or environment).',
      toolset: 'e2e',
      access: 'read',
      routes: ['GET /e2e/tests/:id'],
      input: { testId },
      run: async ({ testId: value }, { api }) => {
        const { test } = await api.request<{ test: TestDto }>({
          method: 'GET',
          path: testPath(value),
        });
        return json({ test: guardTest(test) });
      },
    }),
    defineTool({
      name: 'e2e_run_test',
      openWorld: true,
      title: 'Run one E2E test',
      description: `Runs a single test case again. With regenerate the workspace LLM rewrites its Playwright script first (needs an API key in ADK; otherwise fix the spec yourself with e2e_update_script). Specs missing from the repository are also rewritten by the workspace LLM. ${QUEUE_NOTICE}`,
      toolset: 'e2e',
      access: 'write',
      routes: ['POST /e2e/tests/:id/run'],
      input: {
        testId,
        regenerate: z
          .boolean()
          .default(false)
          .describe('Rewrite the script with the agent before running.'),
      },
      run: async ({ testId: value, regenerate }, { api }) =>
        json(
          await api.request({
            method: 'POST',
            path: `${testPath(value)}/run`,
            body: { regenerate },
          }),
        ),
    }),
    defineTool({
      name: 'e2e_get_script',
      openWorld: true,
      title: 'Get E2E script',
      description:
        'Reads the Playwright script of a test case from the repository, with its file path and web link.',
      toolset: 'e2e',
      access: 'read',
      routes: ['GET /e2e/tests/:id/script'],
      input: { testId },
      run: async ({ testId: value }, { api }) => {
        const { script } = await api.request<{ script: { content?: string | null } }>({
          method: 'GET',
          path: `${testPath(value)}/script`,
        });
        return json({
          script: {
            ...script,
            content: script.content ? untrusted('e2e-script', script.content) : script.content,
          },
        });
      },
    }),
    defineTool({
      name: 'e2e_update_script',
      openWorld: true,
      title: 'Update E2E script',
      description:
        'Commits a new version of a test case Playwright script to the repository (validated first; the run must not be active). Run e2e_run_test afterwards to execute it.',
      toolset: 'e2e',
      access: 'write',
      routes: ['PUT /e2e/tests/:id/script'],
      input: {
        testId,
        content: z
          .string()
          .min(1)
          .max(60_000)
          .describe('Full TypeScript content of the Playwright spec (@playwright/test).'),
      },
      run: async ({ testId: value, content }, { api }) =>
        json(
          await api.request({
            method: 'PUT',
            path: `${testPath(value)}/script`,
            body: { content },
          }),
        ),
    }),
    defineTool({
      name: 'e2e_get_video_url',
      title: 'E2E test video',
      description:
        'Returns a temporary link (1 hour) to the MP4 video recorded for a test case, to share with the user.',
      toolset: 'e2e',
      access: 'read',
      routes: ['GET /e2e/tests/:id/video-url'],
      input: { testId },
      run: async ({ testId: value }, { api }) => {
        const { video } = await api.request<{ video: unknown }>({
          method: 'GET',
          path: `${testPath(value)}/video-url`,
        });
        return json(
          video
            ? { video }
            : {
                video: null,
                message:
                  'This ADK stores videos without object storage, so there is no shareable link; watch it in the E2E Automation page of the web app.',
              },
        );
      },
    }),
    ...testManagementTools,
  ],
};
