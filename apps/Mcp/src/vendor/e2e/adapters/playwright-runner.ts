import { spawn } from 'node:child_process';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { APIResponse } from 'playwright';
import type { E2eMode } from '../domain/e2e-mode.js';
import {
  accessHeaders,
  isLocalGatewayToken,
  isLoopbackRequest,
  localGatewayUrl,
  type AccessServiceToken,
} from '../application/access-routing.js';
import {
  E2eRunnerError,
  redact,
  stripAnsi,
  type E2eApiSnapshot,
  type E2ePageSnapshot,
  type E2eRunInput,
  type E2eRunResult,
  type E2eRunner,
  type E2eSnapshot,
  type E2eStepEvidence,
} from '../application/e2e-runner.js';

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export type ProcessExecutor = (input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}) => Promise<ProcessResult>;

interface BrowserPage {
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  waitForURL?(predicate: (url: URL) => boolean, options: { timeout: number }): Promise<void>;
  waitForLoadState(state: 'networkidle', options: { timeout: number }): Promise<void>;
  evaluate<T>(fn: () => T): Promise<T>;
  route?(
    pattern: string,
    handler: (route: {
      request(): { url(): string; headers(): Record<string, string> };
      continue(options?: { headers: Record<string, string> }): Promise<void>;
      fetch(options: {
        url: string;
        headers?: Record<string, string>;
        maxRedirects: number;
        timeout: number;
      }): Promise<APIResponse>;
      fulfill(options: { response: APIResponse; headers?: Record<string, string> }): Promise<void>;
      abort(): Promise<void>;
    }) => Promise<void>,
  ): Promise<unknown>;
}
interface BrowserLike {
  newPage(options: { ignoreHTTPSErrors: boolean; serviceWorkers?: 'block' }): Promise<BrowserPage>;
  close(): Promise<void>;
}
export interface PlaywrightModule {
  readonly chromium: { launch(options: { headless: boolean }): Promise<BrowserLike> };
}

export interface PlaywrightE2eRunnerOptions {
  /** Directory under the backend package so generated specs resolve @playwright/test. */
  readonly workspaceRoot?: string;
  readonly packageRoot?: string;
  readonly timeoutMs?: number;
  readonly maxPages?: number;
  readonly fetcher?: typeof fetch;
  readonly executor?: ProcessExecutor;
  readonly loadPlaywright?: () => Promise<PlaywrightModule>;
}

const MAX_LOG = 60_000;
const MAX_VIDEO_BYTES = 50_000_000;
const MAX_STEPS = 50;
const MAX_SCREENSHOT_BYTES = 5_000_000;
/** Runtime-only module the spec imports instead of @playwright/test to capture evidence. */
export const EVIDENCE_MODULE = 'adk-evidence';
/** Delay added to each browser action so a human can follow the recording. */
export const SLOW_MO_MS = 600;
/** How long the final screen stays on the recording after the last step. */
export const FINAL_HOLD_MS = 2500;
const API_SPEC_PATHS = [
  '/openapi.json',
  '/swagger.json',
  '/v3/api-docs',
  '/api-docs',
  '/api/openapi.json',
];

export class PlaywrightE2eRunner implements E2eRunner {
  private readonly workspaceRoot: string;
  private readonly packageRoot: string;
  private readonly timeoutMs: number;
  private readonly maxPages: number;
  private readonly fetcher: typeof fetch;
  private readonly executor: ProcessExecutor;
  private readonly loadPlaywright: () => Promise<PlaywrightModule>;

  constructor(options: PlaywrightE2eRunnerOptions = {}) {
    this.packageRoot = options.packageRoot ?? process.cwd();
    this.workspaceRoot = options.workspaceRoot ?? path.join(this.packageRoot, '.e2e-workspaces');
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.maxPages = options.maxPages ?? 5;
    this.fetcher = options.fetcher ?? fetch;
    this.executor = options.executor ?? runProcess;
    this.loadPlaywright = options.loadPlaywright ?? (() => import('playwright'));
  }

  async explore(input: {
    mode: E2eMode;
    url: string;
    transportUrl?: string;
    signal?: AbortSignal;
    accessToken?: AccessServiceToken | null;
  }): Promise<E2eSnapshot> {
    return input.mode === 'backend'
      ? this.exploreApi(input.url, input.accessToken)
      : this.exploreUi(input.url, input.accessToken, input.transportUrl);
  }

  private async exploreApi(url: string, token?: AccessServiceToken | null): Promise<E2eSnapshot> {
    let api: E2eApiSnapshot;
    try {
      const response = await this.fetcher(url, {
        signal: AbortSignal.timeout(10_000),
        headers: accessHeaders(token),
        redirect: 'manual',
      });
      api = {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        excerpt: (await response.text()).slice(0, 2_000),
      };
    } catch (error) {
      throw unreachable(url, error);
    }
    const origin = new URL(url).origin;
    for (const candidate of API_SPEC_PATHS) {
      try {
        const response = await this.fetcher(`${origin}${candidate}`, {
          signal: AbortSignal.timeout(5_000),
          headers: accessHeaders(token),
          redirect: 'manual',
        });
        const body = await response.text();
        if (response.ok && body.trim().startsWith('{')) {
          api = { ...api, specUrl: candidate, spec: body.slice(0, 30_000) };
          break;
        }
      } catch {
        // Optional discovery only.
      }
    }
    return { startUrl: url, pages: [], api };
  }

  private async exploreUi(
    url: string,
    token?: AccessServiceToken | null,
    transportUrl?: string,
  ): Promise<E2eSnapshot> {
    let browser: BrowserLike;
    try {
      browser = await (await this.loadPlaywright()).chromium.launch({ headless: true });
    } catch (error) {
      throw browserError(error);
    }
    try {
      const page = await browser.newPage({
        ignoreHTTPSErrors: true,
        ...(transportUrl ? { serviceWorkers: 'block' as const } : {}),
      });
      if (token || transportUrl) {
        if (!page.route) throw new Error('The browser does not support scoped Access headers.');
        const origin = new URL(url).origin;
        await page.route('**/*', async (route) => {
          const target = route.request();
          const requested = new URL(target.url());
          if (
            transportUrl &&
            (requested.origin === origin ||
              (isLocalGatewayToken(token) && isLoopbackRequest(requested)))
          ) {
            const remote =
              requested.origin === origin
                ? new URL(`${requested.pathname}${requested.search}`, transportUrl).toString()
                : localGatewayUrl(requested, transportUrl);
            const response = await route.fetch({
              url: remote,
              headers: { ...target.headers(), ...accessHeaders(token) },
              maxRedirects: 0,
              timeout: 20_000,
            });
            const headers = response.headers();
            if (headers.location) {
              const redirect = new URL(headers.location, remote);
              if (redirect.origin === new URL(transportUrl).origin)
                headers.location = `${requested.origin}${redirect.pathname}${redirect.search}${redirect.hash}`;
            }
            await route.fulfill({ response, headers });
            return;
          }
          await route.continue(
            requested.origin === (transportUrl ? new URL(transportUrl).origin : origin) && token
              ? { headers: { ...target.headers(), ...accessHeaders(token) } }
              : undefined,
          );
        });
      }
      const visit = async (target: string, settleRedirect = false): Promise<E2ePageSnapshot> => {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
        if (settleRedirect && transportUrl && page.waitForURL) {
          await page
            .waitForURL((current) => current.href !== target, { timeout: 6_000 })
            .catch(() => undefined);
          await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
        }
        return page.evaluate(collectPageSnapshot);
      };
      let first: E2ePageSnapshot;
      try {
        first = await visit(url, true);
      } catch (error) {
        throw unreachable(url, error);
      }
      const pages = [first];
      const origin = new URL(url).origin;
      const queue = [
        ...new Set(
          first.links
            .map((link) => link.href)
            .filter((href) => href.startsWith(origin) && href.split('#')[0] !== first.url),
        ),
      ];
      for (const next of queue.slice(0, Math.max(0, this.maxPages - 1))) {
        try {
          pages.push(await visit(next));
        } catch {
          // Secondary pages are best effort.
        }
      }
      return { startUrl: url, pages };
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  async run(input: E2eRunInput): Promise<E2eRunResult> {
    await fs.mkdir(this.workspaceRoot, { recursive: true });
    const workspace = await fs.mkdtemp(path.join(this.workspaceRoot, 'run-'));
    const secrets = [
      input.credentials.password,
      input.credentials.username,
      input.accessToken?.clientId ?? null,
      input.accessToken?.clientSecret ?? null,
    ];
    try {
      await fs.mkdir(path.join(workspace, 'tests'), { recursive: true });
      await fs.mkdir(path.join(workspace, 'tmp'), { recursive: true });
      await fs.writeFile(
        path.join(workspace, 'tests', 'e2e.spec.ts'),
        withRecordingHold(withStepEvidence(input.script), input.mode),
        'utf8',
      );
      await fs.writeFile(
        path.join(workspace, 'tests', `${EVIDENCE_MODULE}.ts`),
        evidenceModule(input.mode),
        'utf8',
      );
      await fs.writeFile(
        path.join(workspace, 'playwright.config.mjs'),
        runnerConfig(
          input.localOrigin || input.baseUrl,
          input.locale,
          Boolean(input.accessToken),
          Boolean(input.localOrigin),
        ),
        'utf8',
      );
      const started = Date.now();
      const output = await this.executor({
        command: process.execPath,
        args: [
          path.join(this.packageRoot, 'node_modules', '@playwright', 'test', 'cli.js'),
          'test',
          '--config=playwright.config.mjs',
        ],
        cwd: workspace,
        env: childEnvironment(workspace, input),
        timeoutMs: this.timeoutMs,
        signal: input.signal,
      });
      const durationMs = Date.now() - started;
      const logs = redact(stripAnsi(`${output.stdout}\n${output.stderr}`).trim(), secrets).slice(
        -MAX_LOG,
      );
      if (/Executable doesn't exist|playwright install/i.test(logs))
        throw new E2eRunnerError(
          'E2E_BROWSER_NOT_INSTALLED',
          'Chromium is not installed for Playwright. Run "npx playwright install chromium" in apps/Backend.',
        );
      const report = await readReport(path.join(workspace, 'report.json'));
      const outcome = summarizeReport(report);
      const error = output.timedOut
        ? `Test run exceeded ${Math.round(this.timeoutMs / 1000)}s and was stopped.`
        : (outcome.error ?? (outcome.passed ? null : lastLines(logs)));
      return {
        status: outcome.passed && !output.timedOut ? 'passed' : 'failed',
        durationMs: outcome.durationMs ?? durationMs,
        error: error ? redact(error, secrets).slice(0, 8_000) : null,
        logs,
        video: await findVideo(path.join(workspace, 'test-results')),
        steps: await readStepEvidence(path.join(workspace, 'evidence'), secrets),
      };
    } finally {
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function unreachable(url: string, error: unknown): E2eRunnerError {
  const detail = error instanceof Error ? stripAnsi(error.message).split('\n')[0] : '';
  return new E2eRunnerError(
    'E2E_TARGET_UNREACHABLE',
    `Could not reach ${url}. Make sure the application is running and reachable from the backend. ${detail}`.trim(),
  );
}

function browserError(error: unknown): E2eRunnerError {
  const message = error instanceof Error ? error.message : String(error);
  if (/Executable doesn't exist|playwright install/i.test(message))
    return new E2eRunnerError(
      'E2E_BROWSER_NOT_INSTALLED',
      'Chromium is not installed for Playwright. Run "npx playwright install chromium" in apps/Backend.',
    );
  return new E2eRunnerError('E2E_RUNNER_FAILED', stripAnsi(message).slice(0, 2_000));
}

/* v8 ignore start -- serialized into the page and executed by the browser; exercised by the
   real-browser runner test, which Node coverage cannot observe. */
/** Runs inside the browser: a compact, model-friendly description of the current page. */
export function collectPageSnapshot(): E2ePageSnapshot {
  const clean = (value: string | null | undefined, max = 120) =>
    (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const unique = (values: string[], max: number) =>
    [...new Set(values.filter(Boolean))].slice(0, max);
  const labelFor = (element: Element) => {
    const id = element.getAttribute('id');
    const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    return clean(label?.textContent ?? element.closest('label')?.textContent);
  };
  return {
    url: location.href,
    title: clean(document.title),
    headings: unique(
      [...document.querySelectorAll('h1,h2,h3')].map((node) => clean(node.textContent)),
      30,
    ),
    buttons: unique(
      [...document.querySelectorAll('button,[role="button"],input[type="submit"]')].map((node) =>
        clean(
          node.getAttribute('aria-label') ||
            node.textContent ||
            (node as HTMLInputElement).value ||
            '',
        ),
      ),
      60,
    ),
    links: [...document.querySelectorAll('a[href]')]
      .map((node) => ({
        text: clean(node.getAttribute('aria-label') || node.textContent),
        href: (node as HTMLAnchorElement).href,
      }))
      .filter((link) => link.href.startsWith('http'))
      .slice(0, 60),
    fields: unique(
      [...document.querySelectorAll('input,select,textarea')].map((node) =>
        [
          node.tagName.toLowerCase(),
          node.getAttribute('type') && `type=${node.getAttribute('type')}`,
          node.getAttribute('name') && `name=${node.getAttribute('name')}`,
          node.getAttribute('placeholder') &&
            `placeholder="${clean(node.getAttribute('placeholder'))}"`,
          node.getAttribute('aria-label') &&
            `aria-label="${clean(node.getAttribute('aria-label'))}"`,
          labelFor(node) && `label="${labelFor(node)}"`,
        ]
          .filter(Boolean)
          .join(' '),
      ),
      60,
    ),
    testIds: unique(
      [...document.querySelectorAll('[data-testid]')].map((node) =>
        clean(node.getAttribute('data-testid')),
      ),
      80,
    ),
  };
}

/* v8 ignore stop */

export function runnerConfig(
  baseUrl: string,
  locale: string,
  protectedByAccess = false,
  localBrowserOrigin = false,
): string {
  return `export default {
  testDir: './tests',
  timeout: 90000,
  expect: { timeout: 10000 },
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'report.json' }]],
  outputDir: './test-results',
  use: {
    baseURL: ${JSON.stringify(baseUrl)},
    headless: true,
    locale: ${JSON.stringify(locale)},
    viewport: { width: 1280, height: 720 },
    video: { mode: 'on', size: { width: 1280, height: 720 } },
    screenshot: 'off',
    trace: 'off',
    ignoreHTTPSErrors: true,
    ${protectedByAccess || localBrowserOrigin ? "serviceWorkers: 'block'," : ''}
    actionTimeout: 15000,
    navigationTimeout: 30000,
    // Paces every browser action so the recording shows each step of the flow.
    launchOptions: { slowMo: ${SLOW_MO_MS} },
  },
};
`;
}

/**
 * Points the spec's `@playwright/test` import to the evidence module, which re-exports it
 * with a `test.step` that records every top-level step. Run time only: the repository keeps
 * the original spec.
 */
export function withStepEvidence(script: string): string {
  return script.replace(/(\bfrom\s*)(['"])@playwright\/test\2/g, `$1'./${EVIDENCE_MODULE}'`);
}

const UI_EVIDENCE_FIXTURE = `accessBase.extend<{ __adkEvidence: void }>({
  __adkEvidence: [
    async ({ page }, use) => {
      currentPage = page;
      const onResponse = (response: import('@playwright/test').Response) => {
        const kind = response.request().resourceType();
        if (response.status() < 400 || !['document', 'xhr', 'fetch'].includes(kind)) return;
        try {
          recordBrowserDiagnostic('HTTP ' + response.status() + ' (' + kind + ') from ' + new URL(response.url()).origin);
        } catch {
          // An invalid response URL cannot provide a safe origin.
        }
      };
      const onRequestFailed = (request: import('@playwright/test').Request) => {
        const kind = request.resourceType();
        if (!['document', 'xhr', 'fetch'].includes(kind)) return;
        const reason = request.failure()?.errorText ?? '';
        if (reason === 'net::ERR_ABORTED') return;
        try {
          const safeReason = /^net::[A-Z_]+$/.test(reason) ? reason : 'network error';
          recordBrowserDiagnostic(kind + ' request failed at ' + new URL(request.url()).origin + ': ' + safeReason);
        } catch {
          // An invalid request URL cannot provide a safe origin.
        }
      };
      page.on('response', onResponse);
      page.on('requestfailed', onRequestFailed);
      try {
        await use();
      } finally {
        page.off('response', onResponse);
        page.off('requestfailed', onRequestFailed);
        currentPage = null;
      }
    },
    { auto: true },
  ],
})`;

/**
 * Source of the evidence module. Each top-level step appends its outcome to
 * evidence/steps.jsonl and, for UI tests, saves a screenshot of the page as the step ended
 * (passed or failed), so test management platforms get one piece of evidence per step.
 */
export function evidenceModule(mode: E2eMode): string {
  const fixture = mode === 'frontend' ? UI_EVIDENCE_FIXTURE : 'accessBase';
  return String.raw`import { test as base, type Page, type APIRequestContext, type Route, type APIResponse } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export * from '@playwright/test';

const protectedOrigin = new URL(process.env.E2E_BASE_URL || 'http://localhost').origin;
const transportOrigin = process.env.E2E_TRANSPORT_URL || '';
const localGateway = process.env.ADK_LOCAL_GATEWAY === '1';
const clientId = process.env.ADK_ACCESS_CLIENT_ID || '';
const clientSecret = process.env.ADK_ACCESS_CLIENT_SECRET || '';
const tokenHeaders = { 'CF-Access-Client-Id': clientId, 'CF-Access-Client-Secret': clientSecret };

function localRemoteUrl(url: URL): string | null {
  if (!transportOrigin) return null;
  if (url.origin === protectedOrigin)
    return new URL(url.pathname + url.search, transportOrigin).toString();
  if (!localGateway || !['http:', 'https:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) return null;
  return new URL('/_adk/local/' + Buffer.from(url.origin, 'utf8').toString('base64url') + url.pathname + url.search, transportOrigin).toString();
}

async function fulfillRedirectAware(
  route: Route,
  response: APIResponse,
  headers: Record<string, string>,
): Promise<void> {
  const status = response.status();
  if (route.request().resourceType() === 'document' && [301, 302, 303].includes(status) && headers.location) {
    const targetUrl = new URL(headers.location, route.request().url());
    if (!['http:', 'https:'].includes(targetUrl.protocol)) {
      await route.fulfill({ response, headers });
      return;
    }
    const redirectHeaders = { ...headers };
    for (const key of ['location', 'content-length', 'content-encoding', 'content-security-policy', 'refresh', 'transfer-encoding'])
      delete redirectHeaders[key];
    redirectHeaders['content-type'] = 'text/html; charset=utf-8';
    redirectHeaders['cache-control'] = 'no-store';
    const encoded = Buffer.from(targetUrl.toString(), 'utf8').toString('base64');
    await route.fulfill({
      status: 200,
      headers: redirectHeaders,
      body: '<!doctype html><meta charset="utf-8"><script>location.replace(atob("' + encoded + '"))</script>',
    });
    return;
  }
  await route.fulfill({ response, headers });
}

const accessBase = transportOrigin || (clientId && clientSecret) ? base.extend<{ __adkAccess: void }>({
  __adkAccess: [async ({ context }, use) => {
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const remote = localRemoteUrl(url);
      if (remote) {
        const response = await route.fetch({ url: remote, headers: {
          ...request.headers(), ...(clientId && clientSecret ? tokenHeaders : {}),
        }, maxRedirects: 0, timeout: 20000 });
        const headers = response.headers();
        if (headers.location) {
          const redirect = new URL(headers.location, remote);
          if (redirect.origin === new URL(transportOrigin).origin)
            headers.location = url.origin + redirect.pathname + redirect.search + redirect.hash;
        }
        await fulfillRedirectAware(route, response, headers);
        return;
      }
      if (transportOrigin && request.resourceType() === 'document') {
        const response = await route.fetch({ maxRedirects: 0, timeout: 20000 });
        const headers = response.headers();
        if (headers.location) {
          const redirect = new URL(headers.location, request.url());
          if (redirect.origin === new URL(transportOrigin).origin)
            headers.location = protectedOrigin + redirect.pathname + redirect.search + redirect.hash;
        }
        await fulfillRedirectAware(route, response, headers);
        return;
      }
      await route.continue(url.origin === protectedOrigin && clientId && clientSecret
        ? { headers: { ...request.headers(), ...tokenHeaders } } : undefined);
    });
    await use();
  }, { auto: true }],
  request: async ({ playwright }, use) => {
    const raw = await playwright.request.newContext({ baseURL: transportOrigin || protectedOrigin });
    const methods = new Set(['fetch', 'get', 'post', 'put', 'patch', 'delete', 'head']);
    const scoped = new Proxy(raw, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        if (!methods.has(String(key))) return value.bind(target);
        return (url: string | URL, options?: { headers?: Record<string, string> }) => {
          const requested = new URL(String(url), protectedOrigin);
          const destination = localRemoteUrl(requested);
          return value.call(target, destination ?? requested.toString(),
            (requested.origin === protectedOrigin || destination) && clientId && clientSecret
            ? { ...options, headers: { ...options?.headers, ...tokenHeaders } } : options);
        };
      },
    });
    await use(scoped as APIRequestContext);
    await raw.dispose();
  },
}) : base;

const directory = path.join(process.cwd(), 'evidence');
let currentPage: Page | null = null;
let depth = 0;
let position = 0;
let browserDiagnostics: string[] = [];

function recordBrowserDiagnostic(message: string): void {
  browserDiagnostics.push(message);
  if (browserDiagnostics.length > 8) browserDiagnostics.shift();
}

const extended = ${fixture};
type StepBody = (...args: unknown[]) => unknown;
const runStep = extended.step as unknown as (title: string, body: StepBody, options?: unknown) => Promise<unknown>;

async function step(title: string, body: StepBody, options?: unknown): Promise<unknown> {
  // Nested steps belong to the evidence of the top-level step that contains them.
  if (depth > 0) return runStep(title, body, options);
  depth += 1;
  browserDiagnostics = [];
  const index = ++position;
  const started = Date.now();
  let failure: unknown = null;
  try {
    return await runStep(title, body, options);
  } catch (error) {
    failure = error ?? new Error('Step failed');
    throw error;
  } finally {
    depth -= 1;
    fs.mkdirSync(directory, { recursive: true });
    let screenshot: string | null = null;
    if (currentPage && !currentPage.isClosed()) {
      const file = 'step-' + String(index).padStart(2, '0') + '.png';
      try {
        await currentPage.screenshot({ path: path.join(directory, file), timeout: 5000 });
        screenshot = file;
      } catch {
        // Evidence is best effort; the outcome of the step is still recorded.
      }
    }
    const message = failure instanceof Error ? failure.message : failure ? String(failure) : null;
    let browserAddress: string | null = null;
    if (failure && currentPage && !currentPage.isClosed()) {
      try {
        const url = new URL(currentPage.url());
        browserAddress = url.origin === 'null' ? null : url.origin;
      } catch {
        // A closed or uninitialized page has no useful address.
      }
    }
    fs.appendFileSync(
      path.join(directory, 'steps.jsonl'),
      JSON.stringify({
        position: index,
        title,
        status: failure ? 'failed' : 'passed',
        durationMs: Date.now() - started,
        error: message
          ? [
              browserAddress ? 'Browser origin at failure: ' + browserAddress : '',
              ...browserDiagnostics.map((item) => 'Browser network: ' + item),
              message,
            ]
              .filter(Boolean).join('\n').slice(0, 4000)
          : null,
        screenshot,
      }) + '\n',
    );
  }
}
Object.assign(step, extended.step);

export const test = new Proxy(extended, {
  get: (target, property, receiver) =>
    property === 'step' ? step : Reflect.get(target, property, receiver),
});
`;
}

/**
 * Appended to UI specs at run time (never pushed to the repository): keeps the page open
 * after the last step, passed or failed, so the video ends on the final screen instead of
 * being cut when the context closes.
 */
export function withRecordingHold(script: string, mode: E2eMode): string {
  if (mode !== 'frontend') return script;
  return `${script}

import { test as __adkRecording } from '@playwright/test';
__adkRecording.afterEach(async ({ page }) => {
  await page.waitForTimeout(${FINAL_HOLD_MS}).catch(() => undefined);
});
`;
}

export function defaultBrowsersPath(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  if (platform === 'win32') return path.join(home, 'AppData', 'Local', 'ms-playwright');
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'ms-playwright');
  return path.join(home, '.cache', 'ms-playwright');
}

/** A deliberately small environment: no database URLs, API keys or integration secrets. */
export function childEnvironment(workspace: string, input: E2eRunInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '',
    HOME: workspace,
    USERPROFILE: workspace,
    TMPDIR: path.join(workspace, 'tmp'),
    TEMP: path.join(workspace, 'tmp'),
    TMP: path.join(workspace, 'tmp'),
    CI: '1',
    FORCE_COLOR: '0',
    PLAYWRIGHT_BROWSERS_PATH: process.env['PLAYWRIGHT_BROWSERS_PATH'] || defaultBrowsersPath(),
    E2E_BASE_URL: input.localOrigin || input.baseUrl,
    E2E_TRANSPORT_URL: input.localOrigin ? input.baseUrl : '',
    ADK_LOCAL_GATEWAY: input.localOrigin && isLocalGatewayToken(input.accessToken) ? '1' : '',
    E2E_USERNAME: input.credentials.username ?? '',
    E2E_PASSWORD: input.credentials.password ?? '',
    ADK_ACCESS_CLIENT_ID: input.accessToken?.clientId ?? '',
    ADK_ACCESS_CLIENT_SECRET: input.accessToken?.clientSecret ?? '',
  };
  for (const key of ['SystemRoot', 'windir', 'COMSPEC', 'PATHEXT']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

interface ReportResult {
  status?: string;
  duration?: number;
  error?: { message?: string };
  errors?: { message?: string }[];
}
interface ReportSuite {
  specs?: { tests?: { results?: ReportResult[] }[] }[];
  suites?: ReportSuite[];
}
export interface PlaywrightJsonReport {
  suites?: ReportSuite[];
  errors?: { message?: string }[];
  stats?: { expected?: number; unexpected?: number; flaky?: number };
}

async function readReport(file: string): Promise<PlaywrightJsonReport | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as PlaywrightJsonReport;
  } catch {
    return null;
  }
}

export function summarizeReport(report: PlaywrightJsonReport | null): {
  passed: boolean;
  error: string | null;
  durationMs: number | null;
} {
  if (!report) return { passed: false, error: null, durationMs: null };
  const results: ReportResult[] = [];
  const walk = (suites: readonly ReportSuite[] | undefined) => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? [])
        for (const test of spec.tests ?? []) results.push(...(test.results ?? []).slice(-1));
      walk(suite.suites);
    }
  };
  walk(report.suites);
  const failures = results.filter((result) => result.status !== 'passed');
  const messages = [
    ...(report.errors ?? []).map((item) => item.message),
    ...failures.flatMap((result) =>
      result.errors?.length ? result.errors.map((item) => item.message) : [result.error?.message],
    ),
  ].filter((message): message is string => Boolean(message));
  const passed = results.length > 0 && failures.length === 0 && !report.errors?.length;
  return {
    passed,
    error: messages.length
      ? stripAnsi([...new Set(messages)].join('\n\n'))
      : passed
        ? null
        : results.length
          ? `Test finished with status "${failures[0]?.status ?? 'unknown'}".`
          : 'No test was executed.',
    durationMs: results.length
      ? results.reduce((sum, result) => sum + (result.duration ?? 0), 0)
      : null,
  };
}

async function findVideo(directory: string): Promise<Uint8Array | null> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true, recursive: true });
  } catch {
    return null;
  }
  // One recording per page; a test that opens popups or extra pages produces several.
  // The longest recording is the one that follows the main flow.
  let best: Uint8Array | null = null;
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.webm') continue;
    const content = await fs.readFile(path.join(entry.parentPath, entry.name));
    if (content.byteLength > (best?.byteLength ?? 0) && content.byteLength <= MAX_VIDEO_BYTES)
      best = content;
  }
  return best;
}

interface StepLine {
  readonly position?: unknown;
  readonly title?: unknown;
  readonly status?: unknown;
  readonly durationMs?: unknown;
  readonly error?: unknown;
  readonly screenshot?: unknown;
}

/** Reads what the evidence module recorded; a missing or partial file yields fewer steps. */
export async function readStepEvidence(
  directory: string,
  secrets: readonly (string | null)[],
): Promise<E2eStepEvidence[]> {
  let content: string;
  try {
    content = await fs.readFile(path.join(directory, 'steps.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const steps: E2eStepEvidence[] = [];
  for (const line of content.split('\n').slice(0, MAX_STEPS)) {
    let entry: StepLine;
    try {
      entry = JSON.parse(line) as StepLine;
    } catch {
      continue;
    }
    if (typeof entry.position !== 'number' || typeof entry.title !== 'string') continue;
    let screenshot: Uint8Array | null = null;
    if (typeof entry.screenshot === 'string' && /^step-\d+\.png$/.test(entry.screenshot)) {
      const file = await fs.readFile(path.join(directory, entry.screenshot)).catch(() => null);
      screenshot = file && file.byteLength <= MAX_SCREENSHOT_BYTES ? file : null;
    }
    steps.push({
      position: entry.position,
      title: redact(entry.title, secrets).slice(0, 500),
      status: entry.status === 'passed' ? 'passed' : 'failed',
      durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : 0,
      error:
        typeof entry.error === 'string'
          ? redact(stripAnsi(entry.error), secrets).slice(0, 4_000)
          : null,
      screenshot,
    });
  }
  return steps;
}

function lastLines(value: string): string {
  return value.split('\n').slice(-30).join('\n').trim() || 'Test run failed without output.';
}

export const runProcess: ProcessExecutor = ({ command, args, cwd, env, timeoutMs, signal }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, env, windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString('utf8')}`.slice(-1_000_000);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-1_000_000);
    });
    const stop = () => child.kill('SIGKILL');
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve({ exitCode: code ?? 1, stdout, stderr, timedOut });
    });
  });
