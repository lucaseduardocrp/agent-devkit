import { z } from 'zod';
import { segment, type AdkApi } from '../../api/http-client.js';
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
  scriptKind,
  testId,
  testPath,
  type ExternalCaseDto,
  type RunDto,
  type TestDto,
} from './common.js';
import { testManagementTools } from './test-management.js';
import { localOrigin, quickTunnelCommand } from './tunnel-command.js';

const environmentId = id('E2E environment id (from e2e_list_environments).');
const explorationId = id('Exploration script id (from e2e_list_explorations).');
const environmentInput = {
  name: z.string().trim().min(1).max(80).describe('Environment name, e.g. Staging.'),
  baseUrl: z.string().trim().min(1).max(500).describe('Base URL of the application.'),
  username: z.string().trim().max(320).optional().describe('Test account username.'),
  password: z
    .string()
    .max(500)
    .optional()
    .describe('Test account password (stored encrypted, never returned).'),
  variables: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(60),
        value: z.string().max(4_000).optional().describe('Omit to keep the saved value.'),
      }),
    )
    .max(50)
    .optional()
    .describe('Custom variables exposed to the scripts.'),
};
const provider = z
  .enum(['github', 'azure_devops'])
  .describe('Where the Playwright scripts live: github or azure_devops.');
/** The backend adds `warnings` to a local run that starts while no runner of the user is online. */
const RUNNER_NOTICE =
  'When the answer has warnings with code NO_LOCAL_RUNNER, no `devkit runner` is connected: the run is queued and waits up to five minutes. Tell the user to start it (devkit login and devkit e2e setup once, then keep devkit runner open) instead of reporting the run as started.';
const SECRET_NOTICE =
  'Values typed in chat are sent to the model provider; prefer a dedicated test account. The password is stored encrypted and never returned.';

/** Where the server runs a run that does not say: the workspace default, "remote" if unknown. */
async function resolveTarget(
  api: AdkApi,
  executionTarget?: 'remote' | 'local',
): Promise<'remote' | 'local'> {
  if (executionTarget) return executionTarget;
  try {
    const { defaultExecutionTarget } = await api.request<{
      defaultExecutionTarget?: 'remote' | 'local';
    }>({ method: 'GET', path: '/capabilities', withoutWorkspace: true });
    return defaultExecutionTarget === 'local' ? 'local' : 'remote';
  } catch {
    return 'remote';
  }
}

/** Localhost is only reachable when the user's own computer runs the browser. */
async function requireReachableUrl(
  api: AdkApi,
  baseUrl: string,
  executionTarget?: 'remote' | 'local',
): Promise<string> {
  if (executionTarget === 'local') return baseUrl;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return baseUrl;
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) return baseUrl;
  // Only a localhost URL depends on where the run executes: ask for the default only then.
  if ((await resolveTarget(api, executionTarget)) === 'local') return baseUrl;
  throw new Error(
    'The ADK MCP server and E2E worker run on Railway, so localhost cannot reach your computer. Either set executionTarget "local" so the user\'s `devkit runner` runs the browser on their computer, or run e2e_tunnel_setup and pass the public HTTPS URL as baseUrl.',
  );
}

const executionTarget = z
  .enum(['remote', 'local'])
  .describe(
    'Omit it to use the workspace default (E2E_DEFAULT_EXECUTION, "remote" unless set). remote: the ADK worker runs the browser (the app must be publicly reachable). local: the browser runs on the computer of the user who starts the run, through `devkit runner` (outbound HTTPS only, no tunnel), so localhost URLs work; AI planning, healing and results stay in ADK.',
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
  useBrain: z
    .boolean()
    .optional()
    .describe(
      'Plan and write the tests from the Brain (semantic search plus linked documents) instead of a PRD. Then prd is optional.',
    ),
  prdFileNames: z
    .array(z.string().trim().min(1).max(255))
    .max(20)
    .optional()
    .describe('Names of the files the product document came from (display only).'),
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
    readonly useBrain?: boolean;
    readonly brainTools?: readonly string[];
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
  'When a case needs data or configuration prepared first (its preconditions), write its beforeRun following rules.beforeRun; when it creates or changes data, write its afterRun following rules.afterRun to remove it. Both are committed next to the spec, run around the test on every execution, and can be read or changed later with e2e_get_script and e2e_update_script (kind beforeRun or afterRun).',
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
      description: `Creates an E2E run that tests the application with Playwright scripts committed to the chosen repository, runs each test on the ADK worker and records a video. With planning "host" (default, no API key needed) the run waits as a draft: call e2e_prepare, write the test cases and specs yourself and save them with e2e_save_plan. With planning "server" the workspace LLM plans and writes everything (needs an LLM integration in ADK). To automate cases kept on a test management platform (Azure Test Plans, TestRail, Xray) pass importCases (prd becomes optional): each case becomes a test whose spec has one top-level test.step per case step, and the results with step screenshots are published back to the same plan/suite unless reporting says otherwise. To automate test cases already saved in ADK (a local suite, Test Plan or chosen cases, e.g. imported with testplans_import_cases) pass savedCases instead. ${QUEUE_NOTICE} For an app on the user's localhost, prefer executionTarget "local" (the user's devkit runner runs the browser on their computer; check e2e_list_runners); otherwise call e2e_tunnel_setup and pass the tunnel URL as baseUrl and the localhost origin as localOrigin. ${RUNNER_NOTICE} ${SECRET_NOTICE}`,
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
        if (!body.prd && !body.useBrain && !body.importCases && !body.savedCases)
          throw new Error(
            'Provide prd (the product document), useBrain, importCases (test management cases) or savedCases (test cases saved in ADK) to automate.',
          );
        if (body.savedCases && !body.savedCases.suiteId && !body.savedCases.planId)
          throw new Error('savedCases needs a suiteId or a planId.');
        return json(
          await context.api.request({
            method: 'POST',
            path: '/e2e/creations',
            body: {
              ...body,
              baseUrl: await requireReachableUrl(context.api, body.baseUrl, body.executionTarget),
            },
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
            body: {
              ...body,
              baseUrl: await requireReachableUrl(context.api, body.baseUrl, body.executionTarget),
            },
          }),
        ),
    }),
    defineTool({
      name: 'e2e_set_execution',
      title: 'Run E2E locally or on ADK',
      description:
        'Switches an idle E2E run between the ADK worker (remote) and the computer of the user who starts it (local, through `devkit runner`). Going local, a tunnel run targets its localhost origin directly and the tunnel token is removed. Check that the user has a runner online with e2e_list_runners before running a local run. ' +
        RUNNER_NOTICE,
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
            ...(brief.documents.useBrain
              ? { useBrain: true, brainTools: brief.documents.brainTools }
              : {}),
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
              beforeRun: z
                .string()
                .max(60_000)
                .nullable()
                .optional()
                .describe(
                  'Before Run module (rules.beforeRun): builds the preconditions of the case before the test runs. Omit when there are none.',
                ),
              afterRun: z
                .string()
                .max(60_000)
                .nullable()
                .optional()
                .describe(
                  'After Run module (rules.afterRun): removes what the case and its Before Run created, even when they fail. Omit when nothing is left behind.',
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
        'Reads a script of a test case from the repository, with its file path and web link: the Playwright spec, its Before Run (preconditions) or its After Run (cleanup). content is null when that script does not exist.',
      toolset: 'e2e',
      access: 'read',
      routes: ['GET /e2e/tests/:id/script'],
      input: { testId, kind: scriptKind },
      run: async ({ testId: value, kind }, { api }) => {
        const { script } = await api.request<{ script: { content?: string | null } }>({
          method: 'GET',
          path: `${testPath(value)}/script`,
          query: { kind },
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
        'Commits a new version of a test case script to the repository: the Playwright spec, its Before Run or its After Run (validated first; the run must not be active). Before Run and After Run export one default async function that receives { page, request } (only { request } for API runs) and declare no test; empty content turns them off. Run e2e_run_test afterwards to execute it.',
      toolset: 'e2e',
      access: 'write',
      routes: ['PUT /e2e/tests/:id/script'],
      input: {
        testId,
        kind: scriptKind,
        content: z
          .string()
          .max(60_000)
          .describe('Full TypeScript content of the script (imports only from @playwright/test).'),
      },
      run: async ({ testId: value, kind, content }, { api }) =>
        json(
          await api.request({
            method: 'PUT',
            path: `${testPath(value)}/script`,
            body: { content, kind },
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
    defineTool({
      name: 'e2e_list_environments',
      title: 'List E2E environments',
      description:
        'Lists the saved test environments of the workspace (name, base URL, username, custom variable names, whether a password is stored). The first one is the default. Passwords and variable values are never returned.',
      toolset: 'e2e',
      access: 'read',
      routes: ['GET /e2e/environments'],
      input: {},
      run: async (_, { api }) =>
        json(await api.request({ method: 'GET', path: '/e2e/environments' })),
    }),
    defineTool({
      name: 'e2e_create_environment',
      title: 'Create E2E environment',
      description: `Saves a test environment (where an application runs and how to sign in) that E2E runs can start from. ${SECRET_NOTICE}`,
      toolset: 'e2e',
      access: 'write',
      routes: ['POST /e2e/environments'],
      input: environmentInput,
      run: async (input, { api }) =>
        json(await api.request({ method: 'POST', path: '/e2e/environments', body: input })),
    }),
    defineTool({
      name: 'e2e_update_environment',
      title: 'Update E2E environment',
      description:
        'Replaces the settings of a saved environment. Omit the password to keep the saved one; list a variable without a value to keep its saved value, and leave out a variable to remove it.',
      toolset: 'e2e',
      access: 'write',
      routes: ['PUT /e2e/environments/:id'],
      input: { environmentId, ...environmentInput },
      run: async ({ environmentId: value, ...body }, { api }) =>
        json(
          await api.request({
            method: 'PUT',
            path: `/e2e/environments/${segment(value)}`,
            body,
          }),
        ),
    }),
    defineTool({
      name: 'e2e_delete_environment',
      title: 'Delete E2E environment',
      description:
        'Deletes a saved test environment. Runs created from it keep their own settings.',
      toolset: 'e2e',
      access: 'destructive',
      routes: ['DELETE /e2e/environments/:id'],
      input: { environmentId },
      run: async ({ environmentId: value }, { api }) => {
        await api.request({ method: 'DELETE', path: `/e2e/environments/${segment(value)}` });
        return json({ deleted: true, environmentId: value });
      },
    }),
    defineTool({
      name: 'e2e_get_exploration',
      title: 'Get E2E exploration',
      description:
        'Returns the exploration of the tested application for a run: status, the pages captured, the agent log and any error (null when it never ran). Poll it after e2e_explore until the status is ready or failed. Screenshots are only in the web app.',
      toolset: 'e2e',
      access: 'read',
      routes: ['GET /e2e/creations/:id/exploration'],
      input: { runId },
      run: async ({ runId: value }, { api }) => {
        const { exploration } = await api.request<{ exploration: unknown }>({
          method: 'GET',
          path: `${runPath(value)}/exploration`,
        });
        return json({
          exploration: exploration
            ? untrusted('e2e-exploration', JSON.stringify(exploration))
            : null,
          note: UNTRUSTED_CONTENT_RULE,
        });
      },
    }),
    defineTool({
      name: 'e2e_explore',
      title: 'Explore application',
      description:
        'Asks a worker to explore the application of a run again (signing in with the run account); the run and its tests are left alone. Fails while the run is active. Follow it with e2e_get_exploration. The optional description says what to explore (the whole site, one feature, a bug…): the agent mostly follows the menu items and links that name it, and it is kept with the exploration script. By default the script is kept in the database (e2e_list_explorations returns it); storage "repository" commits it as a JSON file next to the run\'s specs instead.',
      toolset: 'e2e',
      access: 'write',
      routes: ['POST /e2e/creations/:id/explore'],
      input: {
        runId,
        description: z
          .string()
          .trim()
          .max(2_000)
          .optional()
          .describe(
            'What to explore, e.g. "the billing screens" or "the bug in the invoice filter".',
          ),
        storage: z
          .enum(['database', 'repository'])
          .optional()
          .describe('Where to keep the exploration script. Defaults to the database.'),
      },
      run: async ({ runId: value, description, storage }, { api }) => {
        const { exploration } = await api.request<{ exploration: unknown }>({
          method: 'POST',
          path: `${runPath(value)}/explore`,
          ...(description || storage
            ? { body: { ...(description ? { description } : {}), ...(storage ? { storage } : {}) } }
            : {}),
        });
        return json({
          exploration: exploration
            ? untrusted('e2e-exploration', JSON.stringify(exploration))
            : null,
          note: QUEUE_NOTICE,
        });
      },
    }),
    defineTool({
      name: 'e2e_list_explorations',
      title: 'List exploration scripts',
      description:
        'Lists the scripts of the finished site explorations kept in the database, newest first: description, status, the ordered actions of the agent and the pages it reached. Pass runId to narrow it to one run. Reuse them to write tests without exploring again.',
      toolset: 'e2e',
      access: 'read',
      routes: ['GET /e2e/explorations'],
      input: { runId: runId.optional() },
      run: async ({ runId: value }, { api }) => {
        const { explorations } = await api.request<{ explorations: unknown[] }>({
          method: 'GET',
          path: '/e2e/explorations',
          ...(value ? { query: { creationId: value } } : {}),
        });
        return json({
          explorations: untrusted('e2e-exploration-scripts', JSON.stringify(explorations ?? [])),
          note: UNTRUSTED_CONTENT_RULE,
        });
      },
    }),
    defineTool({
      name: 'e2e_get_exploration_script',
      title: 'Get exploration script',
      description:
        'Returns one kept exploration script by id (from e2e_list_explorations): its description, actions and pages.',
      toolset: 'e2e',
      access: 'read',
      routes: ['GET /e2e/explorations/:id'],
      input: { explorationId },
      run: async ({ explorationId: value }, { api }) => {
        const { exploration } = await api.request<{ exploration: unknown }>({
          method: 'GET',
          path: `/e2e/explorations/${segment(value)}`,
        });
        return json({
          exploration: exploration
            ? untrusted('e2e-exploration-script', JSON.stringify(exploration))
            : null,
          note: UNTRUSTED_CONTENT_RULE,
        });
      },
    }),
    defineTool({
      name: 'e2e_delete_exploration_script',
      title: 'Delete exploration script',
      description: 'Deletes a kept exploration script. The run and its tests are not affected.',
      toolset: 'e2e',
      access: 'destructive',
      routes: ['DELETE /e2e/explorations/:id'],
      input: { explorationId },
      run: async ({ explorationId: value }, { api }) => {
        await api.request({ method: 'DELETE', path: `/e2e/explorations/${segment(value)}` });
        return json({ deleted: true, explorationId: value });
      },
    }),
    defineTool({
      name: 'e2e_get_action_map',
      title: 'Get E2E action map',
      description:
        'Returns the graph of the pages the tests of a run went through: which tests reached each page, the elements they touched and the order each test followed. Useful to find coverage gaps and where tests fail.',
      toolset: 'e2e',
      access: 'read',
      routes: ['GET /e2e/creations/:id/action-map'],
      input: { runId },
      run: async ({ runId: value }, { api }) => {
        const { map } = await api.request<{ map: unknown }>({
          method: 'GET',
          path: `${runPath(value)}/action-map`,
        });
        return json({
          map: map ? untrusted('e2e-action-map', JSON.stringify(map)) : null,
          note: UNTRUSTED_CONTENT_RULE,
        });
      },
    }),
    defineTool({
      name: 'e2e_get_source',
      title: 'Get workspace Source',
      description:
        'Returns the Source of the workspace: the documentation of the whole system (overview, every flow by feature area, which Brain documents it came from), the pages and flows the agent discovered by exploring the application, and whether an update is running (busy). There is a single Source: every exploration replaces it. source is null before the first exploration. Everything in it comes from the tested application and the Brain.',
      toolset: 'e2e',
      access: 'read',
      routes: ['GET /e2e/source'],
      input: {},
      run: async (_input, { api }) => {
        const state = await api.request<{
          source: unknown;
          anchorId: string | null;
          busy: boolean;
        }>({ method: 'GET', path: '/e2e/source' });
        return json({
          source: state.source ? untrusted('e2e-source', JSON.stringify(state.source)) : null,
          anchorId: state.anchorId,
          busy: state.busy,
          note: UNTRUSTED_CONTENT_RULE,
        });
      },
    }),
    defineTool({
      name: 'e2e_explore_source',
      title: 'Explore the whole application (Source)',
      description:
        'Explores the application of a saved environment as a whole (it signs in with the environment account and follows far more links and menus than a run does) and replaces the Source of the workspace when it ends well; a failed exploration keeps the current Source. When it ends, the workspace AI writes the documentation from the Brain and what was discovered; without an LLM integration the documentation stays empty and you write it with e2e_prepare_source + e2e_save_source_documentation. Fails while an update is running. Follow it with e2e_get_source (busy, then source). The first call needs agentId, the agent whose model documents the system.',
      toolset: 'e2e',
      access: 'write',
      routes: ['POST /e2e/source/explore'],
      input: {
        environmentId,
        agentId: id(
          'Agent that documents the system (from agents_list). Kept for later updates.',
        ).optional(),
        executionTarget: z
          .enum(['remote', 'local'])
          .optional()
          .describe(
            'Where the browser runs. Defaults to "local" (the user\'s devkit runner) for localhost environments and to the workspace default otherwise.',
          ),
      },
      run: async (body, { api }) => {
        const { exploration } = await api.request<{ exploration: unknown }>({
          method: 'POST',
          path: '/e2e/source/explore',
          body,
        });
        return json({
          exploration: exploration
            ? untrusted('e2e-exploration', JSON.stringify(exploration))
            : null,
          note: QUEUE_NOTICE,
        });
      },
    }),
    defineTool({
      name: 'e2e_document_source',
      title: 'Write the Source documentation again',
      description:
        'Asks a worker to write the documentation of the system again from what the Source already discovered and the current Brain, without exploring the application. The documentation in use stays if the new one cannot be written (e2e_get_source shows documentationError). Needs an LLM integration in ADK; without one use e2e_prepare_source + e2e_save_source_documentation. Fails while an update is running. Poll e2e_get_source until busy is false.',
      toolset: 'e2e',
      access: 'write',
      execution: 'server',
      routes: ['POST /e2e/source/document'],
      input: {},
      run: async (_input, { api }) =>
        json(await api.request({ method: 'POST', path: '/e2e/source/document' })),
    }),
    defineTool({
      name: 'e2e_prepare_source',
      title: 'Prepare the Source documentation (host model)',
      description:
        'Returns what you need to write the documentation of the system yourself: what the agent discovered (pages with their controls and the navigation it followed), Brain documents about the system, the rules to follow and the JSON format to answer in. Use brain_search / brain_get_document for anything it leaves out. Then save with e2e_save_source_documentation. Needs a Source: explore with e2e_explore_source first.',
      toolset: 'e2e',
      access: 'read',
      execution: 'host',
      routes: ['GET /e2e/source/brief'],
      input: {},
      run: async (_input, { api }) => {
        const { brief } = await api.request<{
          brief: { brainKnowledge?: readonly { title: string; source: string; content: string }[] };
        }>({ method: 'GET', path: '/e2e/source/brief' });
        const { brainKnowledge = [], ...rest } = brief ?? {};
        return json({
          ...rest,
          brainKnowledge: brainKnowledge.map((document) => ({
            title: document.title,
            source: document.source,
            content: untrusted(document.source, document.content),
          })),
          note: UNTRUSTED_CONTENT_RULE,
        });
      },
    }),
    defineTool({
      name: 'e2e_save_source_documentation',
      title: 'Save the Source documentation',
      description:
        'Saves the documentation of the system you wrote (after e2e_prepare_source): an overview in Markdown and every flow by feature area. It replaces the documentation in use; the discovered pages and flows are untouched. Be exhaustive and use only facts from the Brain and the discovery: origin is "documented" (only the Brain), "discovered" (only seen in the application) or "both".',
      toolset: 'e2e',
      access: 'write',
      routes: ['PUT /e2e/source/documentation'],
      input: {
        overview: z
          .string()
          .trim()
          .min(1)
          .max(40_000)
          .describe('Markdown: purpose, users and permissions, modules, main rules.'),
        areas: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(120).describe('Feature area, e.g. Issues.'),
              description: z.string().trim().max(2_000).optional(),
              flows: z
                .array(
                  z.object({
                    title: z.string().trim().min(1).max(200),
                    description: z.string().trim().max(2_000).optional(),
                    steps: z.array(z.string().trim().min(1).max(1_000)).max(30).optional(),
                    pages: z
                      .array(z.string().trim().min(1).max(300))
                      .max(20)
                      .optional()
                      .describe('Names of the discovered pages the flow goes through.'),
                    origin: z.enum(['documented', 'discovered', 'both']),
                  }),
                )
                .max(80),
            }),
          )
          .max(60),
        brainDocuments: z
          .array(z.object({ title: z.string().max(300), source: z.string().max(2_000) }))
          .max(100)
          .optional()
          .describe('The Brain documents you used (title and source from e2e_prepare_source).'),
      },
      run: async (body, { api }) =>
        json(await api.request({ method: 'PUT', path: '/e2e/source/documentation', body })),
    }),
    ...testManagementTools,
  ],
};
