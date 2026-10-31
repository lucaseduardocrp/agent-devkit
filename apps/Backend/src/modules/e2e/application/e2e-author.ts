import { z } from 'zod';
import { ApplicationError } from '../../../shared/errors.js';
import type { LlmPort } from '../../agents/application/agent-ports.js';
import {
  toLlmApplicationError,
  type AgentService,
} from '../../agents/application/agent-service.js';
import { PromptInjectionGuard } from '../../agents/application/prompt-injection-guard.js';
import type { DynamicProviderFactory } from '../../integrations/application/dynamic-provider-factory.js';
import {
  HOOK_INSTRUCTION_FIELDS,
  type E2eCreation,
  type E2eHookKind,
  type E2eTestCase,
  type E2eVerdict,
} from '../domain/e2e.js';
import type { NewE2eTestCase } from './e2e-store.js';
import type { E2eRunHooks, E2eSnapshot } from './e2e-runner.js';
import { stripCodeFence } from './script-guard.js';

export const MAX_E2E_TESTS = 10;

export interface E2ePlan {
  readonly summary: string;
  readonly tests: readonly NewE2eTestCase[];
}

export interface E2eAnalysis {
  readonly verdict: E2eVerdict;
  readonly summary: string;
}

export interface E2eScriptRequest {
  readonly creation: E2eCreation;
  readonly test: E2eTestCase;
  readonly snapshot: E2eSnapshot | null;
  /** Present when repairing: the rejected or failing previous attempt. */
  readonly previous?: { readonly script: string; readonly problem: string };
  /** Before Run and After Run of the test: the spec must not repeat what they do. */
  readonly hooks?: E2eRunHooks | null;
  readonly signal?: AbortSignal;
}

export interface E2eHookRequest {
  readonly creation: E2eCreation;
  readonly test: E2eTestCase;
  readonly kind: E2eHookKind;
  readonly snapshot: E2eSnapshot | null;
  /** The Before Run already written, so After Run removes exactly what it created. */
  readonly beforeRun?: string | null;
  /** Present when repairing: the rejected previous attempt. */
  readonly previous?: { readonly script: string; readonly problem: string };
  readonly signal?: AbortSignal;
}

export interface E2eAuthor {
  plan(input: {
    creation: E2eCreation;
    snapshot: E2eSnapshot | null;
    signal?: AbortSignal;
  }): Promise<E2ePlan>;
  writeScript(input: E2eScriptRequest): Promise<string>;
  /**
   * Writes the Before Run or After Run of a test from its preconditions and the data it
   * creates; null when the test needs none. Authors without it leave tests without hooks.
   */
  writeHook?(input: E2eHookRequest): Promise<string | null>;
  analyze(input: {
    creation: E2eCreation;
    test: E2eTestCase;
    script: string;
    hooks?: E2eRunHooks | null;
    error: string;
    logs: string;
    signal?: AbortSignal;
  }): Promise<E2eAnalysis>;
}

const planSchema = z.object({
  summary: z.string().trim().min(1).max(20_000),
  tests: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2_000).default(''),
        priority: z.enum(['high', 'medium', 'low']).catch('medium'),
        steps: z.array(z.string().trim().min(1).max(1_000)).max(20).default([]),
      }),
    )
    .min(1),
});

const analysisSchema = z.object({
  verdict: z.enum(['app_bug', 'test_issue', 'environment']),
  summary: z.string().trim().min(1).max(10_000),
});

export function parseJsonObject(text: string): unknown {
  const body = stripCodeFence(text);
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function languageName(locale: string): string {
  return locale === 'en-US' ? 'English' : 'Brazilian Portuguese (pt-BR)';
}

function modeRules(creation: E2eCreation): string {
  return creation.mode === 'backend'
    ? 'Mode: BACKEND. Tests are HTTP API checks executed with the Playwright `request` fixture against the base URL.'
    : 'Mode: FRONTEND. Tests are browser user journeys executed with the Playwright `page` fixture and recorded on video.';
}

function creationContext(creation: E2eCreation) {
  return {
    name: creation.name,
    mode: creation.mode,
    scope: creation.scope,
    baseUrl: creation.localOrigin ?? creation.baseUrl,
    startPath: creation.path,
    testAccountAvailable: Boolean(creation.username && creation.passwordSecret),
    testAccountUsername: creation.username,
    productSpecification: creation.prd.slice(0, 120_000),
    standardizedPrd: creation.prdSummary,
    codeDiff: creation.diff?.slice(0, 60_000) ?? null,
    extraInstructions: creation.instructions,
  };
}

/** How to design the plan; shared by the workspace agent and the MCP host. */
export const planRules = (creation: E2eCreation): string[] => [
  'You are a senior QA automation engineer working like TestSprite.',
  'From the product specification (PRD), the optional code diff, the extra instructions and the snapshot of the running application:',
  '1. Write a concise standardized PRD in Markdown (max ~400 words): product goal, main user flows and key business rules.',
  `2. Design between 3 and ${MAX_E2E_TESTS} high-value, independent end-to-end test cases (fewer when the extra instructions narrow the scope).`,
  modeRules(creation),
  creation.scope === 'diff'
    ? 'Scope: CODE DIFF. Focus only on behavior affected by the provided code diff.'
    : 'Scope: CODEBASE. Cover the most important journeys of the whole product.',
  'Prefer critical journeys, validation rules, permissions and edge cases stated in the PRD. Use only facts from the PRD and the snapshot; never invent features.',
  'Each test starts from the application URL; when a test needs to be authenticated it logs in with the provided test account.',
  'Data or configuration a test needs beforehand (e.g. a record that must exist or be edited first) is built by the Before Run of the test, and what it creates is removed by its After Run; both are written separately, so state them as preconditions and postconditions in the description, not as steps.',
  `Write every text value in ${languageName(creation.locale)}.`,
];

/** How to write each Playwright spec; the same rules the script guard enforces. */
export const scriptRules = (creation: E2eCreation): string[] => [
  "- The only import is: import { test, expect } from '@playwright/test';",
  '- Declare exactly one test(...) whose name starts with the test code (e.g. "TC001 - ...").',
  `- baseURL is configured; navigate with relative paths, starting at '${creation.path}'.`,
  creation.mode === 'backend'
    ? '- Use the `request` fixture; assert status codes and response bodies with expect.'
    : '- Use the `page` fixture. Prefer getByRole/getByLabel/getByPlaceholder/getByText/getByTestId based on the snapshot; avoid brittle CSS or XPath. Assert every expected result with expect. Do not use fixed waits unless strictly necessary.',
  ...(creation.mode === 'frontend'
    ? [
        '- The step screenshot waits for the page to finish loading, then scrolls to and boxes in red the locators the step passed to expect or read from (textContent, getAttribute, evaluateAll, count...). So check what the step verifies on the element that shows it (e.g. the row of the record, then the cell, badge or icon inside it), read values through locators of that element instead of API responses or page.evaluate, and do not end a step on page-wide text, URLs or counts only.',
        '- Before asserting on data that loads asynchronously (tables, lists, reports), wait for it with expect on the element that holds it (e.g. the first row or the target cell toBeVisible), not on a heading that renders before the data. Keep each step about its own expected result: actions that belong to the next step (navigation, language switch, reload) go in that step.',
      ]
    : []),
  creation.mode === 'frontend'
    ? '- After submitting login credentials, wait for the application to finish navigating and assert an application-specific URL or element observed in the snapshot or product specification. Never assume a generic greeting such as "welcome" appears unless it was observed.'
    : '- Assert only documented API responses; do not invent status codes or response fields.',
  creation.mode === 'frontend'
    ? '- If the application is localized, prefer a language-independent element for post-login checks; otherwise accept every supported language shown in the product specification. A greeting visible only in one locale is not a reliable login assertion.'
    : '- Keep API assertions independent of localized UI text.',
  creation.username && creation.passwordSecret
    ? '- When login is needed, use process.env.E2E_USERNAME and process.env.E2E_PASSWORD. Never hardcode credentials.'
    : '- No test account was provided: do not attempt to log in; verify only behavior reachable without authentication.',
  '- Forbidden: other imports, require, Node APIs, process (except the two env vars), file paths, test.use, launching browsers, computed member access with strings (obj["x"]), eval.',
  '- When beforeRunPreparesPreconditions is given, those preconditions are ready when the test starts: do not create them again, and find the records by the names it uses. Leave cleanup to afterRunCleansUp.',
  `- Write exactly one top-level await test.step(...) per listed test step, in the same order, named "${creation.locale === 'en-US' ? 'Step' : 'Passo'} N - <short action>" (N starting at 1), and assert the step's expected result inside it. Each top-level step becomes the step result and screenshot evidence published to the test management platform; nested steps are allowed but count as part of their parent. Keep it under 150 lines.`,
];

/** Answer of the AI when a test needs no Before Run or After Run. */
export const NO_HOOK = 'NONE';

/** How to write a test's Before Run or After Run; the same rules the script guard enforces. */
export const hookRules = (creation: E2eCreation, kind: E2eHookKind): string[] => {
  const fixtures =
    creation.mode === 'frontend'
      ? '{ page, request }: { page: Page; request: APIRequestContext }'
      : '{ request }: { request: APIRequestContext }';
  return [
    kind === 'beforeRun'
      ? '- Before Run runs right before the test and builds every precondition it needs (e.g. the employee, the event, its edition, configuration), so the test starts from them instead of doing that work itself.'
      : '- After Run runs right after the test, even when the test or Before Run failed, and removes every trace of it (records created by Before Run or by the test, changed configuration restored), so no other test is affected.',
    `- Write one module whose only import is from '@playwright/test' (test, expect and types such as Page and APIRequestContext) and that exports exactly: export default async function ${kind}(${fixtures}) { ... }`,
    `- Start the file with a block comment that lists its ${kind === 'beforeRun' ? 'setup' : 'cleanup'} steps for people reading the test, numbered from 1, one per line as "action => expected result" (e.g. "/**\\n * ${kind === 'beforeRun' ? 'Before Run' : 'After Run'} steps:\\n * 1. Create the employee \\"E2E TC001 - Ana\\" through the API => The employee is created\\n */"). Write the steps in ${languageName(creation.locale)}.`,
    '- Implement each listed step as one top-level await test.step("N - <short action>", ...) in the same order, asserting its expected result inside it. Do not declare test(...), test.describe or hooks: the runner calls the function. These steps are not evidence of the test.',
    creation.mode === 'frontend'
      ? '- Prefer the `request` fixture against the application API when the specification documents the endpoints; otherwise use the UI through `page`, starting with page.goto on a relative path.'
      : '- Use the `request` fixture against the application API.',
    '- When userInstructions is given, it is how the user wants this script written (screens to open, buttons to click, routes, records to use): follow it over your own choices, as long as it respects the other rules.',
    '- Modules cannot share variables. Name every record the test needs with the test code (e.g. "E2E TC001 - ...") so the test and After Run find it by that name.',
    kind === 'beforeRun'
      ? '- Make it repeatable: when a record with that name is left from an earlier run, reuse or recreate it. Assert with expect that each precondition is in place.'
      : '- Find each record by name before removing it and skip what does not exist, so the cleanup never fails because the test stopped early.',
    creation.username && creation.passwordSecret
      ? '- When login is needed, use process.env.E2E_USERNAME and process.env.E2E_PASSWORD. Never hardcode credentials.'
      : '- No test account was provided: use only what is reachable without authentication.',
    '- Forbidden: other imports, require, Node APIs, process (except the two env vars), file paths, launching browsers, computed member access with strings (obj["x"]), eval.',
    kind === 'beforeRun'
      ? `- When the test has no precondition to prepare, answer exactly ${NO_HOOK}.`
      : `- When the test and its Before Run create or change nothing, answer exactly ${NO_HOOK}.`,
  ];
};

const PLAN_TASK = (creation: E2eCreation) =>
  [
    ...planRules(creation),
    'Respond ONLY with JSON: {"summary": string, "tests": [{"title": string (short, max 80 chars), "description": string (one or two sentences on what is verified), "priority": "high"|"medium"|"low", "steps": string[] (3-10 concrete steps including expected results)}]}.',
  ].join('\n');

const SCRIPT_TASK = (creation: E2eCreation) =>
  [
    'Write ONE Playwright Test file in TypeScript for the given test case.',
    ...scriptRules(creation),
    '- Return only the code, without Markdown fences or explanations.',
  ].join('\n');

const HOOK_TASK = (creation: E2eCreation, kind: E2eHookKind) =>
  [
    `Write the ${kind === 'beforeRun' ? 'Before Run' : 'After Run'} of the given end-to-end test case in TypeScript, from its description (preconditions, input data, postconditions) and steps.`,
    ...hookRules(creation, kind),
    `- Return only the code (or ${NO_HOOK}), without Markdown fences or explanations.`,
  ].join('\n');

const ANALYSIS_TASK = (creation: E2eCreation) =>
  [
    'Analyze a failed end-to-end test run and classify it:',
    '- "app_bug": the application behaves differently from the specification or expected result.',
    '- "test_issue": the script itself is wrong (locator, wrong assumption about texts or flow, timing) while the application may be correct.',
    '- "environment": the application was unreachable, crashed or infrastructure failed.',
    'Then write a short report for the user with these sections, one per paragraph: Goal, What was executed, What failed, Likely cause, Recommendation.',
    `Write the report in ${languageName(creation.locale)}, including the section titles.`,
    'Respond ONLY with JSON: {"verdict": "app_bug"|"test_issue"|"environment", "summary": string}.',
  ].join('\n');

export interface AgentE2eAuthorOptions {
  readonly agents: AgentService;
  readonly providers?: DynamicProviderFactory;
  readonly defaultLlm?: LlmPort;
}

/** Writes plans, scripts and failure reports with the workspace agent chosen for the run. */
export class AgentE2eAuthor implements E2eAuthor {
  constructor(private readonly options: AgentE2eAuthorOptions) {}

  async plan(input: Parameters<E2eAuthor['plan']>[0]): Promise<E2ePlan> {
    const text = await this.complete(
      input.creation,
      PLAN_TASK(input.creation),
      { ...creationContext(input.creation), applicationSnapshot: input.snapshot },
      input.signal,
    );
    const parsed = planSchema.safeParse(parseJsonObject(text));
    if (!parsed.success)
      throw new ApplicationError('E2E_PLAN_INVALID', 'AI response is not a valid test plan.', 502);
    return {
      summary: parsed.data.summary,
      tests: parsed.data.tests.slice(0, MAX_E2E_TESTS),
    };
  }

  async writeScript(input: E2eScriptRequest): Promise<string> {
    const text = await this.complete(
      input.creation,
      SCRIPT_TASK(input.creation),
      {
        ...creationContext(input.creation),
        testCase: {
          code: input.test.code,
          title: input.test.title,
          description: input.test.description,
          steps: input.test.steps,
        },
        applicationSnapshot: input.snapshot,
        ...(input.hooks?.beforeRun
          ? { beforeRunPreparesPreconditions: input.hooks.beforeRun }
          : {}),
        ...(input.hooks?.afterRun ? { afterRunCleansUp: input.hooks.afterRun } : {}),
        ...(input.previous
          ? {
              previousAttempt: input.previous.script,
              problemToFix: input.previous.problem,
            }
          : {}),
      },
      input.signal,
    );
    return stripCodeFence(text);
  }

  async writeHook(input: E2eHookRequest): Promise<string | null> {
    const text = await this.complete(
      input.creation,
      HOOK_TASK(input.creation, input.kind),
      {
        ...creationContext(input.creation),
        testCase: {
          code: input.test.code,
          title: input.test.title,
          description: input.test.description,
          steps: input.test.steps,
        },
        applicationSnapshot: input.snapshot,
        ...(input.test[HOOK_INSTRUCTION_FIELDS[input.kind]]
          ? { userInstructions: input.test[HOOK_INSTRUCTION_FIELDS[input.kind]] }
          : {}),
        ...(input.beforeRun ? { beforeRun: input.beforeRun } : {}),
        ...(input.previous
          ? { previousAttempt: input.previous.script, problemToFix: input.previous.problem }
          : {}),
      },
      input.signal,
    );
    const code = stripCodeFence(text);
    return !code || code === NO_HOOK ? null : code;
  }

  async analyze(input: Parameters<E2eAuthor['analyze']>[0]): Promise<E2eAnalysis> {
    const text = await this.complete(
      input.creation,
      ANALYSIS_TASK(input.creation),
      {
        testCase: {
          code: input.test.code,
          title: input.test.title,
          description: input.test.description,
          steps: input.test.steps,
        },
        mode: input.creation.mode,
        targetUrl: `${input.creation.localOrigin ?? input.creation.baseUrl}${input.creation.path}`,
        script: input.script,
        ...(input.hooks?.beforeRun ? { beforeRun: input.hooks.beforeRun } : {}),
        ...(input.hooks?.afterRun ? { afterRun: input.hooks.afterRun } : {}),
        error: input.error.slice(0, 8_000),
        runnerLog: input.logs.slice(-12_000),
      },
      input.signal,
    );
    const parsed = analysisSchema.safeParse(parseJsonObject(text));
    return parsed.success
      ? parsed.data
      : { verdict: 'app_bug', summary: stripCodeFence(text).slice(0, 10_000) };
  }

  private async complete(
    creation: E2eCreation,
    task: string,
    context: unknown,
    signal?: AbortSignal,
  ): Promise<string> {
    const agent = await this.options.agents.getAgent(creation.workspaceId, creation.agentId);
    const workflow = await this.options.agents.getWorkflow(creation.workspaceId);
    if (workflow.enabled && workflow.steps.length > 0) {
      const result = await this.options.agents.executeAgent(
        creation.workspaceId,
        agent.id,
        {
          prompt: `${task}\n\nE2E task context:\n${JSON.stringify(context, null, 2)}`,
          includeKnowledge: false,
        },
        {
          requestId: `e2e-agent-${creation.id}`,
          workspaceId: creation.workspaceId,
          ownerId: creation.ownerId,
        },
        signal,
      );
      return result.result;
    }
    const llm =
      (await this.options.providers?.resolveLlmProvider(
        creation.ownerId,
        undefined,
        undefined,
        agent.model ?? undefined,
      )) ?? this.options.defaultLlm;
    if (!llm)
      throw new ApplicationError(
        'PROVIDER_NOT_AVAILABLE',
        'No LLM provider available for E2E automation.',
        503,
      );
    const { payload, nonce } = PromptInjectionGuard.wrapWithSandboxEnvelope(
      JSON.stringify(context, null, 2),
    );
    const instruction = PromptInjectionGuard.buildSystemInstruction(
      `${agent.instructions}\n\n## E2E Automation task\n${task}`,
      nonce,
    );
    let response: Awaited<ReturnType<LlmPort['complete']>>;
    try {
      response = await llm.complete({ prompt: payload, instruction }, signal);
    } catch (error) {
      throw toLlmApplicationError(error);
    }
    return PromptInjectionGuard.verifyOutput(response.text, instruction);
  }
}
