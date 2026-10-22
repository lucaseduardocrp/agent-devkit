import { z } from 'zod';
import { ApplicationError } from '../../../shared/errors.js';
import type { LlmPort } from '../../agents/application/agent-ports.js';
import {
  toLlmApplicationError,
  type AgentService,
} from '../../agents/application/agent-service.js';
import { PromptInjectionGuard } from '../../agents/application/prompt-injection-guard.js';
import type { DynamicProviderFactory } from '../../integrations/application/dynamic-provider-factory.js';
import type { E2eCreation, E2eTestCase, E2eVerdict } from '../domain/e2e.js';
import type { NewE2eTestCase } from './e2e-store.js';
import type { E2eSnapshot } from './e2e-runner.js';
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
  readonly signal?: AbortSignal;
}

export interface E2eAuthor {
  plan(input: {
    creation: E2eCreation;
    snapshot: E2eSnapshot | null;
    signal?: AbortSignal;
  }): Promise<E2ePlan>;
  writeScript(input: E2eScriptRequest): Promise<string>;
  analyze(input: {
    creation: E2eCreation;
    test: E2eTestCase;
    script: string;
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
  `- Write exactly one top-level await test.step(...) per listed test step, in the same order, named "${creation.locale === 'en-US' ? 'Step' : 'Passo'} N - <short action>" (N starting at 1), and assert the step's expected result inside it. Each top-level step becomes the step result and screenshot evidence published to the test management platform; nested steps are allowed but count as part of their parent. Keep it under 150 lines.`,
];

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
