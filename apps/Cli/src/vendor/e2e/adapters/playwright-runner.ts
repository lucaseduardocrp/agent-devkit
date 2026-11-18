import { spawn } from 'node:child_process';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { APIResponse } from 'playwright';
import type { E2eMode } from '../domain/e2e-mode.js';
import { ExploreWorkPool } from '../application/e2e-explore-share.js';
import {
  accessHeaders,
  isLocalGatewayToken,
  isLoopbackRequest,
  localGatewayUrl,
  type AccessServiceToken,
} from '../application/access-routing.js';
import {
  E2eRunnerError,
  focusKeywords,
  redact,
  stripAnsi,
  type E2eAgentAction,
  type E2eAgentElement,
  type E2eAgentPlanItem,
  type E2eApiSnapshot,
  type E2eCredentials,
  type E2eExploreAgent,
  type E2eExploreEvent,
  type E2eExploreInput,
  type E2eLiveActivity,
  type E2eLiveFrame,
  type E2ePageSnapshot,
  type E2eRunInput,
  type E2eRunResult,
  type E2eRunner,
  type E2eSnapshot,
  type E2eStepEvidence,
  type E2eTrail,
  type E2eTrailElement,
  type E2eTrailPage,
  type E2eTrailTouch,
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
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
  /** The members below drive the click-through exploration; a browser without them only crawls links. */
  url?(): string;
  /** The recording of the page, when the browser was asked to record; its file exists once the page closes. */
  video?(): { path(): Promise<string> } | null;
  close?(): Promise<void>;
  screenshot?(options: { type: 'jpeg'; quality: number; timeout: number }): Promise<Uint8Array>;
  mouse?: { click(x: number, y: number): Promise<void> };
  keyboard?: { type(text: string): Promise<void>; press(key: string): Promise<void> };
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
  newPage(options: {
    ignoreHTTPSErrors: boolean;
    serviceWorkers?: 'block';
    recordVideo?: { dir: string; size: { width: number; height: number } };
  }): Promise<BrowserPage>;
  close(): Promise<void>;
}
export interface PlaywrightModule {
  readonly chromium: {
    launch(options: { headless: boolean; args?: string[] }): Promise<BrowserLike>;
  };
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
  /**
   * Extra Chromium arguments. Host access of a local install passes its host resolver rules here
   * and the matching `fetcher` (see shared/host-access.ts): the composition root builds both, so
   * this file keeps to Playwright and Node built-ins and `devkit runner` vendors it as it is.
   */
  readonly browserArgs?: readonly string[];
  /** Most navigation targets the agent clicks while exploring a site. */
  readonly exploreSteps?: number;
  /** Most pages one exploration captures, counting the ones reached by links. */
  readonly explorePages?: number;
  /** Time the click-through exploration may take. */
  readonly exploreBudgetMs?: number;
  /** Pause after each action of the exploration, so the page reacts before it is read. */
  readonly settleMs?: number;
  /** Most steps the AI agent takes while exploring a site. */
  readonly agentSteps?: number;
  /** Time the AI agent may take to explore a site. */
  readonly agentBudgetMs?: number;
  /** Longest wait for a page that is still loading (a splash screen) to show something. */
  readonly renderWaitMs?: number;
  /** How often the frame of a running test is read for the live view. */
  readonly liveIntervalMs?: number;
  /** Time the virtual cursor of the evidence takes to glide to what the agent acts on. */
  readonly glideMs?: number;
  /**
   * Browsers that explore a site at once, each signed in on its own and covering its share of
   * the navigation. 1 explores with a single browser. Defaults to `E2E_EXPLORERS`, else 3.
   */
  readonly explorers?: number;
  /** How slowly tests run so the video is easy to follow; defaults to `E2E_PACE`, else balanced. */
  readonly pace?: E2ePace;
}

const MAX_LOG = 60_000;
const MAX_VIDEO_BYTES = 50_000_000;
const EXPLORE_VIDEO_SIZE = { width: 1280, height: 720 };
const MAX_STEPS = 50;
const MAX_SCREENSHOT_BYTES = 5_000_000;
/** Runtime-only module the spec imports instead of @playwright/test to capture evidence. */
export const EVIDENCE_MODULE = 'adk-evidence';
/** Delay added to each browser action so a human can follow the recording. */
export const SLOW_MO_MS = 600;
/** How long the final screen stays on the recording after the last step. */
export const FINAL_HOLD_MS = 2500;

/**
 * How fast a test runs in the browser. The pauses only make the recording easy to follow (every
 * action slowed down, the cursor gliding, the checked elements held on screen): they add up to
 * most of the time of a short test, so the default keeps the video readable and drops the rest.
 */
export type E2ePace = 'fast' | 'balanced' | 'recorded';
export interface E2ePaceSettings {
  /** Delay Playwright adds to each browser action. */
  readonly slowMo: number;
  /** Time the virtual cursor takes to glide to what the test acts on. */
  readonly glideMs: number;
  /** How long the elements a step checked stay outlined before the next step. */
  readonly evidenceHoldMs: number;
  /** How long the final screen stays on the recording. */
  readonly finalHoldMs: number;
}
export const PACES: Readonly<Record<E2ePace, E2ePaceSettings>> = {
  recorded: { slowMo: SLOW_MO_MS, glideMs: 650, evidenceHoldMs: 1200, finalHoldMs: FINAL_HOLD_MS },
  balanced: { slowMo: 120, glideMs: 220, evidenceHoldMs: 450, finalHoldMs: 1000 },
  fast: { slowMo: 0, glideMs: 0, evidenceHoldMs: 0, finalHoldMs: 400 },
};
/** Pace of the runner when nothing says otherwise: `E2E_PACE`, else balanced. */
export function resolvePace(value: string | undefined = process.env.E2E_PACE): E2ePace {
  return value === 'fast' || value === 'recorded' || value === 'balanced' ? value : 'balanced';
}
/** Time each Before Run or After Run adds to the test's own timeout. */
export const HOOK_TIMEOUT_MS = 90_000;
/** Runtime-only files the spec imports to call its Before Run and After Run. */
export const HOOK_MODULES = { beforeRun: 'adk-before-run', afterRun: 'adk-after-run' } as const;
const API_SPEC_PATHS = [
  '/openapi.json',
  '/swagger.json',
  '/v3/api-docs',
  '/api-docs',
  '/api/openapi.json',
];

/** How far one exploration of a UI goes. */
interface ExploreLimits {
  /** Pages opened through the links of the first screen, counting that screen. */
  readonly links: number;
  /** Navigation targets clicked. */
  readonly steps: number;
  /** Pages captured in all. */
  readonly pages: number;
  /** Time the click-through may take. */
  readonly budgetMs: number;
}

/** Least a thorough exploration gets: enough to go through every screen of most applications. */
export const THOROUGH_EXPLORE_LIMITS: ExploreLimits = {
  links: 40,
  steps: 150,
  pages: 60,
  budgetMs: 6 * 60_000,
};

export class PlaywrightE2eRunner implements E2eRunner {
  private readonly workspaceRoot: string;
  private readonly packageRoot: string;
  private readonly timeoutMs: number;
  private readonly maxPages: number;
  private readonly fetcher: typeof fetch;
  private readonly executor: ProcessExecutor;
  private readonly loadPlaywright: () => Promise<PlaywrightModule>;
  /** Extra Chromium arguments: the host resolver rules of host access, when on. */
  private readonly browserArgs: string[];
  private readonly exploreSteps: number;
  private readonly explorePages: number;
  private readonly exploreBudgetMs: number;
  private readonly settleMs: number;
  private readonly renderWaitMs: number;
  private readonly agentSteps: number;
  private readonly agentBudgetMs: number;
  private readonly liveIntervalMs: number;
  private readonly glideMs: number;
  private readonly explorers: number;
  private readonly pace: E2ePaceSettings;
  /** Where the virtual cursor of each exploring page stopped, to draw it again after a navigation. */
  private readonly cursors = new WeakMap<BrowserPage, { x: number; y: number; label: string }>();

  constructor(options: PlaywrightE2eRunnerOptions = {}) {
    this.packageRoot = options.packageRoot ?? process.cwd();
    this.workspaceRoot = options.workspaceRoot ?? path.join(this.packageRoot, '.e2e-workspaces');
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.maxPages = options.maxPages ?? 5;
    this.fetcher = options.fetcher ?? fetch;
    this.executor = options.executor ?? runProcess;
    this.loadPlaywright = options.loadPlaywright ?? (() => import('playwright'));
    this.browserArgs = [...(options.browserArgs ?? [])];
    this.exploreSteps = options.exploreSteps ?? 24;
    this.explorePages = options.explorePages ?? 16;
    this.exploreBudgetMs = options.exploreBudgetMs ?? 90_000;
    this.settleMs = options.settleMs ?? 700;
    this.renderWaitMs = options.renderWaitMs ?? 12_000;
    this.agentSteps = options.agentSteps ?? 60;
    this.agentBudgetMs = options.agentBudgetMs ?? 12 * 60_000;
    this.liveIntervalMs = options.liveIntervalMs ?? 1_000;
    this.glideMs = options.glideMs ?? 650;
    const wanted = options.explorers ?? (Number(process.env.E2E_EXPLORERS) || DEFAULT_EXPLORERS);
    this.explorers = Math.min(MAX_EXPLORERS, Math.max(1, Math.floor(wanted)));
    this.pace = PACES[options.pace ?? resolvePace()];
  }

  /**
   * Shows the agent like a person using the page: the cursor glides to the point (when given) and
   * the caption names the step. Decoration only: a page that cannot show it changes nothing.
   */
  private async moveCursor(
    page: BrowserPage,
    point: ExplorePoint | null,
    label: string,
  ): Promise<void> {
    const last = this.cursors.get(page);
    const at = point ?? last ?? null;
    const glideMs = point ? this.glideMs : 0;
    try {
      await page.evaluate(moveExploreCursor, {
        x: at?.x ?? null,
        y: at?.y ?? null,
        label,
        glideMs,
      });
      if (at) this.cursors.set(page, { x: at.x, y: at.y, label });
      if (glideMs > 0) await new Promise((resolve) => setTimeout(resolve, glideMs + 80));
    } catch {
      // The cursor is evidence decoration: the step runs anyway.
    }
  }

  /** The cursor presses and a ripple marks where the click lands. */
  private async pressCursor(page: BrowserPage): Promise<void> {
    await page.evaluate(pressExploreCursor).catch(noop);
  }

  /** A navigation drops the layer of the page: it is drawn again where the cursor stopped. */
  private async restoreCursor(page: BrowserPage): Promise<void> {
    const last = this.cursors.get(page);
    if (!last) return;
    await page
      .evaluate(moveExploreCursor, {
        x: last.x,
        y: last.y,
        label: last.label,
        glideMs: 0,
        restore: true,
      })
      .catch(noop);
  }

  async explore(input: E2eExploreInput): Promise<E2eSnapshot> {
    return input.mode === 'backend'
      ? this.exploreApi(input.url, input.accessToken)
      : this.exploreUi(input);
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

  /**
   * Browses a site like a person getting to know it: opens it, signs in with the test account
   * when it starts on a sign-in form, follows its links and then clicks through its navigation
   * (menus, tabs, sidebars), so applications that change screens without changing the address
   * are covered too. Every new screen becomes a page of the snapshot.
   */
  private async exploreUi(input: E2eExploreInput): Promise<E2eSnapshot> {
    const { url, accessToken: token, transportUrl } = input;
    const own: ExploreLimits = {
      links: this.maxPages,
      steps: this.exploreSteps,
      pages: this.explorePages,
      budgetMs: this.exploreBudgetMs,
    };
    const limits: ExploreLimits = input.thorough
      ? {
          links: Math.max(own.links, THOROUGH_EXPLORE_LIMITS.links),
          steps: Math.max(own.steps, THOROUGH_EXPLORE_LIMITS.steps),
          pages: Math.max(own.pages, THOROUGH_EXPLORE_LIMITS.pages),
          budgetMs: Math.max(own.budgetMs, THOROUGH_EXPLORE_LIMITS.budgetMs),
        }
      : own;
    const emit = (event: E2eExploreEvent) => {
      try {
        input.onProgress?.(event);
      } catch {
        // Following the exploration is optional; a failing listener never stops it.
      }
    };
    let browser: BrowserLike;
    try {
      browser = await (
        await this.loadPlaywright()
      ).chromium.launch({
        headless: true,
        ...(this.browserArgs.length ? { args: this.browserArgs } : {}),
      });
    } catch (error) {
      throw browserError(error);
    }
    // The browsers of the AI agent are recorded, so the exploration can be watched as a video.
    let recording: string | null = null;
    const recorded: { worker: number; page: BrowserPage }[] = [];
    try {
      if (input.agent)
        recording = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-explore-')).catch(() => null);
      // Each page is a browser of its own (no cookies or storage in common).
      const openPage = async (worker = 1): Promise<BrowserPage> => {
        const page = await browser.newPage({
          ignoreHTTPSErrors: true,
          ...(transportUrl ? { serviceWorkers: 'block' as const } : {}),
          ...(recording ? { recordVideo: { dir: recording, size: EXPLORE_VIDEO_SIZE } } : {}),
        });
        if (recording) recorded.push({ worker, page });
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
        return page;
      };
      const page = await openPage();
      const pages: E2ePageSnapshot[] = [];
      const seen = new Set<string>();
      /** Reads the screen a browser is on; a screen no browser saw before joins the snapshot. */
      const capturer = (target: BrowserPage) => async (): Promise<E2ePageSnapshot> => {
        // What is captured is the screen with its content, not the skeleton drawn before it.
        await this.waitForSettled(target);
        const snapshot = withoutSharedHeadings(await target.evaluate(collectPageSnapshot), pages);
        const key = pageKey(snapshot);
        if (!seen.has(key)) {
          seen.add(key);
          pages.push(snapshot);
          emit({ kind: 'page', page: snapshot, screenshot: await frameOf(target) });
        }
        return snapshot;
      };
      const capture = capturer(page);
      const visit = async (target: string, settleRedirect = false): Promise<E2ePageSnapshot> => {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(noop);
        if (settleRedirect && transportUrl && page.waitForURL) {
          await page
            .waitForURL((current) => current.href !== target, { timeout: 6_000 })
            .catch(() => undefined);
          await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
        }
        // An app that draws its screen with scripts shows a loading screen first.
        if (!(await this.waitForRender(page)) && settleRedirect)
          emit({ kind: 'log', action: 'note', target: 'not_rendered', result: null });
        const snapshot = await capture();
        emit({ kind: 'log', action: 'navigate', target, result: pageName(snapshot) });
        return snapshot;
      };
      let first: E2ePageSnapshot;
      try {
        first = await visit(url, true);
      } catch (error) {
        throw unreachable(url, error);
      }
      if (await this.signIn(page, input.credentials, emit)) first = await capture();
      emit({ kind: 'phase', phase: 'exploring' });
      const origin = new URL(url).origin;
      const { mouse: agentMouse, keyboard: agentKeyboard } = page;
      let agentRan = false;
      if (input.agent && agentMouse && agentKeyboard) {
        agentRan = true;
        // The navigation is shared between the browsers, and so are the tests of the run.
        const shares =
          this.explorers > 1 ? await this.splitAreas(page, origin, this.explorers) : [];
        const workers = Math.max(1, shares.length);
        const pool = workers > 1 ? new ExploreWorkPool(shares, input.tests ?? []) : null;
        // What each browser plans and where it is, so none repeats what another does.
        const board = new Map<number, { flows: string[]; screen: string }>();
        // Steps and time are the exploration's, however many pieces of work they are spent on.
        const allSteps = input.thorough
          ? Math.max(this.agentSteps, THOROUGH_AGENT_STEPS)
          : this.agentSteps;
        const stepBudget = { left: Math.ceil(allSteps * 1.5) };
        const deadline =
          Date.now() +
          (input.thorough
            ? Math.max(this.agentBudgetMs, THOROUGH_AGENT_BUDGET_MS)
            : this.agentBudgetMs);
        // How the exploration ended is told once, by the first browser, when everyone is done.
        let ending = null as E2eExploreEvent | null;
        interface Browser {
          readonly page: BrowserPage;
          readonly capture: () => Promise<E2ePageSnapshot>;
          readonly outcome: { finished: boolean; acted: number };
          readonly report: (event: E2eExploreEvent) => void;
          round: number;
        }
        const browsers: Browser[] = [];
        /** One piece of work after another, until there is none left for this browser. */
        const work = async (index: number): Promise<boolean> => {
          const browser = browsers[index]!;
          let finished = true;
          for (;;) {
            const batch = pool ? pool.claim(index) : null;
            if (pool && !batch) break;
            browser.round += 1;
            const assignment = batch
              ? { worker: index + 1, workers, round: browser.round, shares, ...batch }
              : undefined;
            const agent: E2eExploreAgent = (observation, signal) =>
              input.agent!(assignment ? { ...observation, assignment } : observation, signal);
            finished = await this.agentExplore({
              page: browser.page,
              mouse: browser.page.mouse!,
              keyboard: browser.page.keyboard!,
              agent,
              url,
              pages,
              capture: browser.capture,
              emit: browser.report,
              signal: input.signal,
              thorough: input.thorough === true,
              maxPages: limits.pages,
              workers,
              ...(assignment ? { worker: assignment.worker, board, stepBudget, deadline } : {}),
              outcome: browser.outcome,
            });
            // Only an agent that is done with its piece goes on to another one.
            if (!pool || !finished || !browser.outcome.finished || input.signal?.aborted) break;
          }
          board.delete(index + 1);
          return finished;
        };
        const explorer = async (index: number): Promise<boolean> => {
          const lead = index === 0;
          let own = page;
          let ownCapture = capture;
          if (!lead) {
            try {
              // Another browser: it opens the site and signs in with the same account.
              own = await openPage(index + 1);
              const hasAccount = Boolean(
                input.credentials?.username && input.credentials?.password,
              );
              // Like the first browser, it waits for the redirect to the sign-in screen (an SSO
              // answers after the page loads) before looking for the form; without that wait it
              // would stay signed out and every address it opens would lead back to the sign-in.
              let signedIn = false;
              for (let attempt = 0; attempt < 3 && !signedIn; attempt++) {
                await own.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
                await own.waitForLoadState('networkidle', { timeout: 5_000 }).catch(noop);
                if (transportUrl && own.waitForURL) {
                  await own
                    .waitForURL((current) => current.href !== url, { timeout: 6_000 })
                    .catch(noop);
                  await own.waitForLoadState('networkidle', { timeout: 5_000 }).catch(noop);
                }
                await this.waitForRender(own);
                await this.signIn(own, input.credentials, (event) => {
                  if (event.kind === 'frame' || event.kind === 'page') emit(event);
                });
                signedIn = !hasAccount || !(await own.evaluate(findSignInForm).catch(() => null));
              }
              // A browser that is not signed in has nothing to explore: the others take its work.
              if (!signedIn) throw new Error('The explorer browser could not sign in.');
              ownCapture = capturer(own);
            } catch (error) {
              // What this browser was to do is left to the others.
              pool?.release(index);
              throw error;
            }
          }
          browsers[index] = {
            page: own,
            capture: ownCapture,
            outcome: { finished: false, acted: 0 },
            round: 0,
            report: lead
              ? (event) => {
                  if (
                    event.kind === 'log' &&
                    event.action === 'note' &&
                    ENDING_NOTE.test(event.target)
                  )
                    ending = event;
                  else emit(event);
                }
              : (event) => {
                  if (event.kind === 'phase' || (event.kind === 'log' && event.action === 'note'))
                    return;
                  emit(event);
                },
          };
          return work(index);
        };
        const results = await Promise.allSettled(
          Array.from({ length: workers }, (_, index) => explorer(index)),
        );
        // Whatever is left (a browser could not start, or ended on a limit) is not forgotten: the
        // first browser takes it, from anyone's queue, until nothing is left or a limit is reached.
        const first = results[0]!;
        if (pool && first.status === 'fulfilled' && first.value && pool.remaining > 0) {
          pool.releaseAll();
          if (browsers[0]!.outcome.finished) await work(0);
        }
        const lead = results[0]!;
        // A browser that could not start only leaves its work to the others.
        if (lead.status === 'rejected') throw lead.reason;
        if (ending && ending.kind === 'log') {
          const acted = browsers.reduce((sum, item) => sum + item.outcome.acted, 0);
          emit({ ...ending, target: `${ending.target.split(':')[0]}:${acted}` });
        }
        // The agents explore the whole site; the navigation is clicked through only if the lead failed.
        if (lead.value) return { startUrl: url, pages };
      }
      const keywords = focusKeywords(input.focus);
      const queue = [
        ...new Set(
          first.links
            .filter((link) => keywords.length === 0 || matchesFocus(keywords, link.text, link.href))
            .map((link) => link.href)
            .filter((href) => href.startsWith(origin) && href.split('#')[0] !== first.url),
        ),
      ];
      for (const next of queue.slice(0, Math.max(0, limits.links - 1))) {
        try {
          await visit(next);
        } catch {
          // Secondary pages are best effort.
        }
      }
      const { mouse } = page;
      if (mouse) {
        // Links may have left the start screen; the navigation is clicked through from there.
        if (queue.length || agentRan)
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(noop);
        await this.clickThrough(
          page,
          mouse,
          url,
          pages,
          capture,
          emit,
          input.signal,
          keywords,
          limits,
        );
      }
      return { startUrl: url, pages };
    } finally {
      if (recording) await sendRecordings(recorded, recording, emit);
      await browser.close().catch(() => undefined);
    }
  }

  /**
   * Fills the sign-in form the site opened on with the test account and submits it. False
   * when there is no account, no form or no way to type: the exploration then stays signed out.
   */
  private async signIn(
    page: BrowserPage,
    credentials: E2eCredentials | null | undefined,
    emit: (event: E2eExploreEvent) => void,
  ): Promise<boolean> {
    const { mouse, keyboard } = page;
    if (!mouse || !keyboard) return false;
    const username = credentials?.username ?? '';
    const password = credentials?.password ?? '';
    const hasAccount = Boolean(username && password);
    const form = await page.evaluate(findSignInForm).catch(() => null);
    if (!form || !hasAccount) {
      // Say why the agent stays signed out: it explains a site overview with a single screen.
      if (form) emit({ kind: 'log', action: 'note', target: 'sign_in_no_account', result: null });
      else if (hasAccount)
        emit({ kind: 'log', action: 'note', target: 'sign_in_no_form', result: null });
      return false;
    }
    emit({ kind: 'phase', phase: 'signing_in' });
    // Sign-in pages animate and shift while they load, so a point measured earlier can land on
    // another field. Each field is focused where it is now and what it holds is checked.
    let filled = false;
    for (let attempt = 0; attempt < 3 && !filled; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 600));
      if (form.user) {
        const state = await page.evaluate(inspectSignIn, 'user').catch(() => null);
        if (!state?.focused) continue;
        await this.moveCursor(page, state.point ?? null, 'Sign in · type the username');
        await this.pressCursor(page);
        await keyboard.type(username);
      }
      const state = await page.evaluate(inspectSignIn, 'password').catch(() => null);
      if (!state?.focused) continue;
      await this.moveCursor(page, state.point ?? null, 'Sign in · type the password');
      await this.pressCursor(page);
      await keyboard.type(password);
      const result = await page.evaluate(inspectSignIn, null).catch(() => null);
      filled =
        !result ||
        (result.passwordLength === password.length && (!form.user || result.user === username));
    }
    await this.moveCursor(page, null, 'Sign in · submit');
    await this.emitFrame(page, emit);
    await keyboard.press('Enter');
    await this.settle(page);
    await this.waitForRender(page);
    await this.restoreCursor(page);
    // A form still on screen after submitting means the account was not accepted.
    const stillThere = await page.evaluate(findSignInForm).catch(() => null);
    if (stillThere) emit({ kind: 'log', action: 'note', target: 'sign_in_failed', result: null });
    const landed = await page.evaluate(collectPageSnapshot).catch(() => null);
    emit({
      kind: 'log',
      action: 'sign_in',
      target: username,
      result: landed ? pageName(landed) : null,
    });
    return true;
  }

  /**
   * The menu items, tabs and links of the screen, dealt round-robin to the browsers. Empty when
   * there is too little to share (a single browser then explores everything).
   */
  private async splitAreas(
    page: BrowserPage,
    origin: string,
    explorers: number,
  ): Promise<string[][]> {
    const labels = await page.evaluate(listNavAreas, origin).catch(() => [] as string[]);
    const workers = Math.min(explorers, labels.length);
    if (workers < 2) return [];
    const shares: string[][] = Array.from({ length: workers }, () => []);
    labels.forEach((label, index) => shares[index % workers]!.push(label));
    return shares;
  }

  /**
   * Clicks each navigation target once (never one that signs out or deletes), reading the
   * screen each click leads to, until nothing new is left or a limit is reached.
   */
  private async clickThrough(
    page: BrowserPage,
    mouse: NonNullable<BrowserPage['mouse']>,
    url: string,
    pages: readonly E2ePageSnapshot[],
    capture: () => Promise<E2ePageSnapshot>,
    emit: (event: E2eExploreEvent) => void,
    signal: AbortSignal | undefined,
    keywords: readonly string[],
    limits: ExploreLimits,
  ): Promise<void> {
    const origin = new URL(url).origin;
    const tried: string[] = [];
    // With a focus, controls outside it are only clicked while looking for the area to explore.
    let detours = keywords.length ? FOCUS_DETOURS : 0;
    const deadline = Date.now() + limits.budgetMs;
    const stop = (code: string) =>
      emit({ kind: 'log', action: 'note', target: `${code}:${tried.length}`, result: null });
    for (let step = 0; step < limits.steps; step++) {
      if (signal?.aborted) return;
      if (pages.length >= limits.pages) return stop('stopped_pages');
      if (Date.now() > deadline) return stop('stopped_time');
      const target = await page
        .evaluate(nextExploreTarget, { tried, origin, keywords: [...keywords], detours })
        .catch(() => null);
      if (!target) return stop('stopped_no_targets');
      tried.push(target.id);
      if (keywords.length && !target.matched) detours = Math.max(0, detours - 1);
      // The target is outlined in the page, so the frame shows where the agent is going.
      await this.moveCursor(page, target, `#${tried.length} Click "${target.label}"`);
      await this.emitFrame(page, emit);
      await this.pressCursor(page);
      let landed: E2ePageSnapshot | null = null;
      try {
        await mouse.click(target.x, target.y);
        await this.settle(page);
        // A link that left the site is not part of it: back to where the exploration started.
        if (page.url && !page.url().startsWith(origin))
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.evaluate(clearExploreMark);
        await this.restoreCursor(page);
        landed = await capture();
      } catch {
        // A click that closed the page or broke a navigation only costs this target.
      }
      emit({
        kind: 'log',
        action: 'click',
        target: target.label,
        result: landed ? pageName(landed) : null,
      });
      await this.emitFrame(page, emit);
    }
    stop('stopped_steps');
  }

  /**
   * Waits until the page shows something to work with (a control or some text), up to a limit.
   * False when it still looks like a loading screen.
   */
  private async waitForRender(page: BrowserPage, timeoutMs = this.renderWaitMs): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await page.evaluate(isRendered).catch(() => true)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  /** Waits (briefly) for loading marks to go away; a page that never settles is captured anyway. */
  private async waitForSettled(page: BrowserPage): Promise<void> {
    const deadline = Date.now() + Math.min(this.renderWaitMs, 4_000);
    // Only an explicit "still loading" waits: a page that cannot tell is taken as it is.
    while ((await page.evaluate(isSettled).catch(() => true)) === false) {
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  /**
   * Lets the AI agent browse like a person: it plans the flows the tests need, then reads the
   * screen, picks a control, acts on it and reads the result, until every flow is walked through
   * (or cannot be). Every action is logged with its reason. False when the agent failed, so the
   * caller explores by itself instead.
   */
  private async agentExplore(ctx: {
    page: BrowserPage;
    mouse: NonNullable<BrowserPage['mouse']>;
    keyboard: NonNullable<BrowserPage['keyboard']>;
    agent: E2eExploreAgent;
    url: string;
    pages: readonly E2ePageSnapshot[];
    capture: () => Promise<E2ePageSnapshot>;
    emit: (event: E2eExploreEvent) => void;
    signal: AbortSignal | undefined;
    thorough: boolean;
    maxPages: number;
    /** Browsers exploring together: each takes a share of the steps. */
    workers?: number;
    /** This browser's number and the board every browser writes its plan and screen on. */
    worker?: number;
    board?: Map<number, { flows: string[]; screen: string }>;
    /** Steps and time shared by every piece of work of a parallel exploration. */
    stepBudget?: { left: number };
    deadline?: number;
    /** Filled in as the agent works: whether it ended on its own, and how much it did. */
    outcome?: { finished: boolean; acted: number };
  }): Promise<boolean> {
    const { page, mouse, keyboard, agent, url, pages, capture, emit, signal } = ctx;
    const origin = new URL(url).origin;
    const allSteps = ctx.thorough
      ? Math.max(this.agentSteps, THOROUGH_AGENT_STEPS)
      : this.agentSteps;
    // A share a little larger than its fair part: the areas are not all the same size.
    const workers = ctx.workers ?? 1;
    const maxSteps = workers > 1 ? Math.ceil((allSteps * 1.5) / workers) : allSteps;
    const maxPages = Math.max(ctx.maxPages, AGENT_PAGES);
    const deadline =
      ctx.deadline ??
      Date.now() +
        (ctx.thorough
          ? Math.max(this.agentBudgetMs, THOROUGH_AGENT_BUDGET_MS)
          : this.agentBudgetMs);
    if (ctx.outcome) ctx.outcome.finished = false;
    const note = (code: string, reason?: string) =>
      emit({
        kind: 'log',
        action: 'note',
        target: code,
        result: null,
        ...(reason ? { reason } : {}),
      });
    const history: string[] = [];
    let plan: readonly E2eAgentPlanItem[] = [];
    let acted = 0;
    let previous = '';
    let repeats = 0;
    let undecided = 0;
    let unfinished = 0;
    /** Flows whose evidence was already saved: a flow is shown once, whatever the plan says later. */
    const evidenced = new Set<string>();
    let lastUrl = url;
    for (let step = 1; step <= maxSteps; step++) {
      if (signal?.aborted) return true;
      if (pages.length >= maxPages) {
        note(`stopped_pages:${acted}`);
        return true;
      }
      if (Date.now() > deadline) {
        note(`stopped_time:${acted}`);
        return true;
      }
      if (ctx.stepBudget && ctx.stepBudget.left-- <= 0) {
        note(`stopped_steps:${acted}`);
        return true;
      }
      const view = await page.evaluate(listAgentElements).catch(() => null);
      const current = await page.evaluate(collectPageSnapshot).catch(() => null);
      if (!view || !current) {
        note(`agent_failed:${acted}`, 'The page could not be read.');
        return false;
      }
      let action: E2eAgentAction;
      const { worker, board } = ctx;
      if (worker && board)
        board.set(worker, { flows: plan.map((item) => item.flow), screen: pageName(current) });
      const others =
        worker && board
          ? [...board]
              .filter(([peer]) => peer !== worker)
              .map(([peer, state]) => ({ worker: peer, ...state }))
          : undefined;
      try {
        action = await agent(
          {
            step,
            maxSteps,
            page: current,
            text: view.text,
            elements: view.elements,
            history: history.slice(-AGENT_HISTORY),
            screens: pages.map(pageName),
            plan,
            ...(others ? { others } : {}),
          },
          signal,
        );
        undecided = 0;
      } catch (error) {
        if (signal?.aborted) return true;
        // One answer the model got wrong is not the end of the exploration: ask again.
        undecided += 1;
        if (undecided > AGENT_RETRIES) {
          note(`agent_failed:${acted}`, errorLine(error));
          return false;
        }
        history.push(`${step}. (no decision: ${errorLine(error)})`);
        continue;
      }
      if (action.plan?.length && JSON.stringify(action.plan) !== JSON.stringify(plan)) {
        const first = plan.length === 0;
        const before = plan;
        plan = action.plan;
        // The screen in front of the agent shows what it just did: it is the evidence of every
        // flow it now calls done, saved under the name of the flow.
        for (const item of plan) {
          if (item.status !== 'done' || evidenced.has(item.flow)) continue;
          if (before.some((old) => old.flow === item.flow && old.status === 'done')) continue;
          evidenced.add(item.flow);
          await this.captureFlow(page, emit, item.flow);
        }
        // The others see the new plan from their next step on.
        if (worker && board)
          board.set(worker, { flows: plan.map((item) => item.flow), screen: pageName(current) });
        if (first)
          note(
            `agent_plan:${plan.length}`,
            plan
              .map((item) => item.flow)
              .join(' · ')
              .slice(0, MAX_PLAN_NOTE),
          );
      }
      if (action.kind === 'finish') {
        const pending = plan.filter((item) => item.status === 'pending');
        // Flows left undone and steps left to do them: send the agent back to work, a few times.
        if (pending.length && step < maxSteps && unfinished < AGENT_UNFINISHED) {
          unfinished += 1;
          history.push(
            `${step}. finish: not done (flows of your plan still pending: ${pending
              .map((item) => item.flow)
              .join('; ')
              .slice(0, 300)}; walk through them, or mark them blocked if they cannot be done)`,
          );
          continue;
        }
        note(`agent_done:${acted}`, action.reason.slice(0, MAX_REASON));
        if (ctx.outcome) ctx.outcome.finished = true;
        return true;
      }
      const element =
        action.kind === 'click' || action.kind === 'type' || action.kind === 'select'
          ? view.elements.find((item) => item.id === action.element)
          : undefined;
      const line = `${action.kind}:${element?.label ?? ''}:${
        action.kind === 'type'
          ? action.value
          : action.kind === 'select'
            ? action.option
            : action.kind === 'press'
              ? action.key
              : action.kind === 'scroll'
                ? action.direction
                : action.kind === 'goto'
                  ? action.url
                  : ''
      }:${current.url}`;
      repeats = line === previous ? repeats + 1 : 0;
      previous = line;
      if (repeats >= 3) {
        note(`agent_stuck:${acted}`);
        return true;
      }
      if (repeats >= 1) {
        history.push(
          `${step}. ${action.kind}: not done (you just did exactly this; try something else)`,
        );
        continue;
      }
      const refusal = agentRefusal(action, element, origin, page.url?.() ?? lastUrl);
      if (refusal) {
        history.push(`${step}. ${action.kind}: not done (${refusal})`);
        continue;
      }
      await this.emitFrame(page, emit);
      let label: string;
      let logged: 'click' | 'type' | 'select' | 'press' | 'scroll' | 'navigate';
      // The screen once the action is done, for the replay of the exploration.
      let shot: Uint8Array | null;
      try {
        if (action.kind === 'goto') {
          logged = 'navigate';
          label = new URL(action.url, page.url?.() ?? lastUrl).toString();
          await this.moveCursor(page, null, `#${acted + 1} Open ${label.slice(0, 80)}`);
          await page.goto(label, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        } else if (action.kind === 'press') {
          logged = 'press';
          label = action.key;
          await this.moveCursor(page, null, `#${acted + 1} Press ${label}`);
          await keyboard.press(action.key);
        } else if (action.kind === 'scroll') {
          logged = 'scroll';
          label = action.direction;
          await this.moveCursor(page, null, `#${acted + 1} Scroll ${label}`);
          await page.evaluate(scrollAgentPage, action.direction);
        } else {
          // Clicks, typing and choices start by pointing at the control, outlined for the live view.
          let point = await page.evaluate(locateAgentElement, element!.id).catch(() => null);
          if (!point) {
            history.push(`${step}. ${action.kind}: not done (the control is gone)`);
            continue;
          }
          label = element!.label;
          // Like a person: the cursor glides to the control, shows the step and presses.
          const verb =
            action.kind === 'select' ? 'Select in' : action.kind === 'type' ? 'Type in' : 'Click';
          const caption = `#${acted + 1} ${verb} "${label.slice(0, 60)}"`;
          await this.moveCursor(page, point, caption);
          // A page still loading shifts its layout while the cursor glides (a menu that moves
          // down, a banner that opens): the control is found again, and the cursor and its
          // outline follow it, so the click lands on the control the agent chose and not on its
          // neighbour.
          let gone = false;
          for (let settled = 0; settled < 3; settled += 1) {
            const now = await page.evaluate(locateAgentElement, element!.id).catch(() => null);
            if (!now) {
              gone = true;
              break;
            }
            const moved = Math.abs(now.x - point.x) > 2 || Math.abs(now.y - point.y) > 2;
            point = now;
            if (!moved) break;
            await this.moveCursor(page, point, caption);
          }
          if (gone) {
            history.push(`${step}. ${action.kind}: not done (the control is gone)`);
            continue;
          }
          await this.emitFrame(page, emit);
          await this.pressCursor(page);
          if (action.kind === 'select') {
            logged = 'select';
            const chosen = await page.evaluate(selectAgentOption, {
              id: element!.id,
              option: action.option,
            });
            if (!chosen) {
              history.push(
                `${step}. select: not done (${element!.label} has no choice "${action.option.slice(0, 60)}")`,
              );
              continue;
            }
            label = `${label} = ${chosen}`;
          } else {
            await mouse.click(point.x, point.y);
            if (action.kind === 'type') {
              logged = 'type';
              await keyboard.press('Control+A');
              await keyboard.type(action.value.slice(0, MAX_TYPED));
              if (action.submit) await keyboard.press('Enter');
              label = `${label} = ${action.value.slice(0, 60)}`;
            } else logged = 'click';
          }
        }
        await this.settle(page);
        await this.waitForRender(page, Math.min(this.renderWaitMs, 4_000));
        // A link that left the site is not part of it: back to where the agent was.
        if (page.url && !page.url().startsWith(origin))
          await page.goto(lastUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        if (page.url) lastUrl = page.url();
        await page.evaluate(clearExploreMark);
        await this.restoreCursor(page);
        shot = await frameOf(page);
      } catch (error) {
        // An action that closed the page or broke a navigation only costs this step.
        history.push(`${step}. ${action.kind}: failed (${errorLine(error)})`);
        continue;
      }
      acted += 1;
      if (ctx.outcome) ctx.outcome.acted += 1;
      const landed = await capture().catch(() => null);
      const where = landed ? pageName(landed) : null;
      emit({
        kind: 'log',
        action: logged,
        target: label,
        result: where,
        reason: action.reason.slice(0, MAX_REASON),
        ...(shot ? { screenshot: shot } : {}),
        url: page.url?.() ?? lastUrl,
        ...(workers > 1 && ctx.worker ? { worker: ctx.worker } : {}),
      });
      history.push(`${step}. ${logged} "${label}" -> ${where ?? 'nothing readable'}`);
      await this.emitFrame(page, emit);
    }
    note(`stopped_steps:${acted}`);
    return true;
  }

  /**
   * Saves the screen as the evidence of a flow the agent walked through, once its content is
   * drawn. Never throws: a screen that cannot be read costs the capture, not the exploration.
   */
  private async captureFlow(
    page: BrowserPage,
    emit: (event: E2eExploreEvent) => void,
    flow: string,
  ): Promise<void> {
    try {
      await this.waitForSettled(page);
      const snapshot = await page.evaluate(collectPageSnapshot);
      emit({ kind: 'page', page: snapshot, screenshot: await frameOf(page), flow });
    } catch {
      // The flow stays done; it only has no picture.
    }
  }

  private async emitFrame(
    page: BrowserPage,
    emit: (event: E2eExploreEvent) => void,
  ): Promise<void> {
    const image = await frameOf(page);
    if (image) emit({ kind: 'frame', image });
  }

  private async settle(page: BrowserPage): Promise<void> {
    await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(noop);
    if (this.settleMs) await new Promise((resolve) => setTimeout(resolve, this.settleMs));
  }

  async run(input: E2eRunInput): Promise<E2eRunResult> {
    await fs.mkdir(this.workspaceRoot, { recursive: true });
    const workspace = await fs.mkdtemp(path.join(this.workspaceRoot, 'run-'));
    const secrets = [
      input.credentials.password,
      input.credentials.username,
      input.accessToken?.clientId ?? null,
      input.accessToken?.clientSecret ?? null,
      ...Object.values(input.variables ?? {}),
    ];
    try {
      await fs.mkdir(path.join(workspace, 'tests'), { recursive: true });
      await fs.mkdir(path.join(workspace, 'tmp'), { recursive: true });
      const hooks = presentHooks(input);
      const timeoutMs = this.timeoutMs + Object.keys(hooks).length * HOOK_TIMEOUT_MS;
      await fs.writeFile(
        path.join(workspace, 'tests', 'e2e.spec.ts'),
        withRecordingHold(
          withHooks(withStepEvidence(input.script), hooks, input.mode),
          input.mode,
          this.pace.finalHoldMs,
        ),
        'utf8',
      );
      for (const [kind, content] of Object.entries(hooks) as [HookKind, string][])
        await fs.writeFile(
          path.join(workspace, 'tests', `${HOOK_MODULES[kind]}.ts`),
          withStepEvidence(content),
          'utf8',
        );
      await fs.writeFile(
        path.join(workspace, 'tests', `${EVIDENCE_MODULE}.ts`),
        evidenceModule(input.mode, this.pace),
        'utf8',
      );
      await fs.writeFile(
        path.join(workspace, 'playwright.config.mjs'),
        runnerConfig(
          input.localOrigin || input.baseUrl,
          input.locale,
          Boolean(input.accessToken),
          Boolean(input.localOrigin),
          this.browserArgs,
          this.pace.slowMo,
        ),
        'utf8',
      );
      const started = Date.now();
      const evidence = path.join(workspace, 'evidence');
      const stopLive =
        input.onLive && input.mode === 'frontend'
          ? watchLive(evidence, this.liveIntervalMs, input.onLive)
          : noop;
      const output = await this.executor({
        command: process.execPath,
        args: [
          path.join(this.packageRoot, 'node_modules', '@playwright', 'test', 'cli.js'),
          'test',
          '--config=playwright.config.mjs',
        ],
        cwd: workspace,
        env: childEnvironment(workspace, input),
        timeoutMs,
        signal: input.signal,
      }).finally(stopLive);
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
        ? `Test run exceeded ${Math.round(timeoutMs / 1000)}s and was stopped.`
        : (outcome.error ?? (outcome.passed ? null : lastLines(logs)));
      return {
        status: outcome.passed && !output.timedOut ? 'passed' : 'failed',
        durationMs: outcome.durationMs ?? durationMs,
        error: error ? redact(error, secrets).slice(0, 8_000) : null,
        logs,
        video: await findVideo(path.join(workspace, 'test-results')),
        steps: await readStepEvidence(evidence, secrets),
        trail: input.mode === 'frontend' ? await readTrail(evidence, secrets) : null,
      };
    } finally {
      await fs.rm(workspace, { recursive: true, force: true }).catch(noop);
    }
  }
}

const noop = () => undefined;

/** Lines of what the AI agent did that it is reminded of at each step. */
/** The notes that tell how an exploration ended. */
const ENDING_NOTE = /^(agent_done|stopped_|agent_stuck)/;
const DEFAULT_EXPLORERS = 3;
const MAX_EXPLORERS = 6;
const AGENT_HISTORY = 12;
const MAX_REASON = 300;
const MAX_TYPED = 200;
/** What an exploration of the whole application lets the AI agent do. */
const THOROUGH_AGENT_STEPS = 150;
const THOROUGH_AGENT_BUDGET_MS = 25 * 60_000;
/** Pages the AI agent may reach: walking through flows visits far more screens than a crawl. */
const AGENT_PAGES = 40;
/** Times in a row the model may fail to give a usable step before the agent is given up. */
const AGENT_RETRIES = 2;
/** Times the agent is sent back to work when it finishes with flows of its plan pending. */
const AGENT_UNFINISHED = 3;
const MAX_PLAN_NOTE = 600;
/** Controls an exploration never uses: they sign out, delete or deactivate. */
const RISKY_CONTROL =
  /log ?out|sign ?out|sair|encerrar|delete|remove|excluir|apagar|remover|unsubscribe|deactivate|desativar/i;
const AGENT_KEYS = new Set([
  'Enter',
  'Escape',
  'Tab',
  'ArrowDown',
  'ArrowUp',
  'ArrowLeft',
  'ArrowRight',
  'PageDown',
  'PageUp',
  'Home',
  'End',
]);

function errorLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return stripAnsi(text).split('\n')[0]!.slice(0, 200);
}

/** Why the exploration does not do what the AI agent asked; null when it may. */
function agentRefusal(
  action: E2eAgentAction,
  element: E2eAgentElement | undefined,
  origin: string,
  here: string,
): string | null {
  if (action.kind === 'click' || action.kind === 'type' || action.kind === 'select') {
    if (!element) return `there is no control #${action.element}`;
    if (RISKY_CONTROL.test(element.label))
      return `"${element.label}" signs out or deletes, which an exploration never does`;
    if (action.kind === 'type' && element.type === 'password')
      return 'passwords are typed by the sign-in only';
    if (action.kind === 'type' && element.type === 'file') return 'files cannot be chosen here';
    if (action.kind === 'select' && element.role !== 'select')
      return `"${element.label}" is not a drop-down list; click it and click its choice`;
    return null;
  }
  if (action.kind === 'press')
    return AGENT_KEYS.has(action.key) ? null : `the key ${action.key} is not allowed`;
  if (action.kind === 'goto') {
    try {
      return new URL(action.url, here).origin === origin ? null : 'it leaves the site';
    } catch {
      return 'it is not an address';
    }
  }
  return null;
}

/** JPEG of what the browser shows; null when it cannot take one. */
async function frameOf(page: BrowserPage): Promise<Uint8Array | null> {
  if (!page.screenshot) return null;
  return page.screenshot({ type: 'jpeg', quality: 55, timeout: 5_000 }).catch(() => null);
}

/** Screens differ by address (without the fragment), title or first headings. */
export function pageKey(page: E2ePageSnapshot): string {
  return [
    page.url.split('#')[0],
    page.title,
    ...page.headings.slice(0, 2),
    // A dialog or another tab is another state of the same route, and worth its own capture.
    ...(page.dialog ? [`dialog:${page.dialog}`] : []),
    ...(page.tab ? [`tab:${page.tab}`] : []),
  ].join('|');
}

/**
 * How a screen is called in the exploration log: its first heading, else its title; with the
 * dialog open over it, when there is one.
 */
export function pageName(page: E2ePageSnapshot): string {
  const screen = page.headings[0] || page.title || page.url;
  return page.dialog && page.dialog !== screen ? `${screen} · ${page.dialog}` : screen;
}

/**
 * Moves the headings that every screen seen so far shows (a title of the page's frame) behind the
 * ones that tell this screen from the others, so it is not called by them.
 */
export function withoutSharedHeadings(
  page: E2ePageSnapshot,
  seen: readonly E2ePageSnapshot[],
): E2ePageSnapshot {
  if (seen.length < 2 || page.headings.length < 2) return page;
  const shared = (heading: string) => seen.every((other) => other.headings.includes(heading));
  const own = page.headings.filter((heading) => !shared(heading));
  if (own.length === 0 || own.length === page.headings.length) return page;
  return { ...page, headings: [...own, ...page.headings.filter(shared)] };
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
  const visible = (node: Element) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1 && node.checkVisibility({ visibilityProperty: true });
  };
  const DIALOGS =
    'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"],.modal.show,.modal.in';
  const CHROME = 'header,nav,aside,[role="banner"],[role="navigation"],[role="complementary"]';
  const title = clean(document.title);
  // The topmost dialog on screen: the last one in the page.
  const dialog = [...document.querySelectorAll(DIALOGS)].filter(visible).pop() ?? null;
  const dialogTitle = dialog
    ? clean(
        dialog.querySelector('h1,h2,h3,h4,[class*="title" i],[class*="header" i]')?.textContent ||
          dialog.getAttribute('aria-label') ||
          dialog.textContent,
      )
    : '';
  const tab = clean(
    [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].find(visible)?.textContent,
  );
  // What names the screen comes first: a heading the title repeats, then the ones in the main
  // content, then the rest, with the headings of the page's frame (header, menus) and of dialogs
  // last. An application that keeps one heading on every screen must not name them all alike.
  const lowerTitle = title.toLowerCase();
  const rank = (node: Element) => {
    if (dialog?.contains(node)) return 4;
    const text = clean(node.textContent).toLowerCase();
    if (text.length > 2 && lowerTitle.includes(text)) return 0;
    if (node.closest('main,[role="main"]')) return 1;
    return node.closest(CHROME) ? 3 : 2;
  };
  const headingNodes = [...document.querySelectorAll('h1,h2,h3')]
    .filter(visible)
    .map((node, order) => ({ node, order, rank: rank(node) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order);
  return {
    url: location.href,
    title,
    headings: unique(
      headingNodes.map((item) => clean(item.node.textContent)),
      30,
    ),
    ...(dialogTitle ? { dialog: dialogTitle } : {}),
    ...(tab ? { tab } : {}),
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

/**
 * Runs inside the browser: the controls the AI agent can use, each numbered and marked in the page
 * (`data-adk-agent`), and the text on the screen.
 */
export function listAgentElements(): { elements: E2eAgentElement[]; text: string } {
  for (const old of document.querySelectorAll('[data-adk-agent]'))
    old.removeAttribute('data-adk-agent');
  const clean = (value: string | null | undefined, max = 80) =>
    (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const roles = [
    'button',
    'link',
    'tab',
    'menuitem',
    'checkbox',
    'switch',
    'radio',
    'combobox',
    'option',
    'treeitem',
  ];
  const selector = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    'summary',
    '[contenteditable="true"]',
    ...roles.map((role) => '[role="' + role + '"]'),
  ].join(',');
  const elements: E2eAgentElement[] = [];
  for (const node of document.querySelectorAll<HTMLElement>(selector)) {
    if (elements.length >= 120) break;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (!node.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    if (node.matches(':disabled,[aria-disabled="true"]')) continue;
    const field = node as HTMLInputElement;
    const tag = node.tagName.toLowerCase();
    if (tag === 'input' && field.type === 'hidden') continue;
    const named = node.id
      ? document.querySelector('label[for="' + CSS.escape(node.id) + '"]')
      : null;
    const label = clean(
      node.getAttribute('aria-label') ||
        named?.textContent ||
        node.closest('label')?.textContent ||
        node.textContent ||
        field.placeholder ||
        node.getAttribute('title') ||
        field.name,
    );
    const isField = tag === 'input' || tag === 'select' || tag === 'textarea';
    if (!label && !isField) continue;
    const id = elements.length + 1;
    node.setAttribute('data-adk-agent', String(id));
    const hasValue = isField && field.type !== 'password' && field.type !== 'file';
    elements.push({
      id,
      role: node.getAttribute('role') || tag,
      label: label || field.type || tag,
      ...(isField && field.type ? { type: field.type } : {}),
      ...(hasValue && field.value ? { value: clean(field.value, 60) } : {}),
      ...(node instanceof HTMLAnchorElement ? { href: node.getAttribute('href') ?? '' } : {}),
      ...(field.type === 'checkbox' || field.type === 'radio' ? { checked: field.checked } : {}),
      ...(node instanceof HTMLSelectElement
        ? { options: [...node.options].slice(0, 25).map((option) => clean(option.text, 60)) }
        : {}),
    });
  }
  return { elements, text: clean(document.body?.innerText, 3_000) };
}

/**
 * Runs inside the browser: picks the choice of a drop-down list marked by `listAgentElements`
 * whose text is (or contains) `option`. The text of the choice made, or null when there is none.
 */
export function selectAgentOption(arg: { id: number; option: string }): string | null {
  const node = document.querySelector<HTMLSelectElement>('[data-adk-agent="' + arg.id + '"]');
  if (!node || !(node instanceof HTMLSelectElement)) return null;
  const wanted = arg.option.trim().toLowerCase();
  const choices = [...node.options].filter((option) => !option.disabled);
  const choice =
    choices.find((option) => option.text.trim().toLowerCase() === wanted) ??
    choices.find((option) => option.text.toLowerCase().includes(wanted));
  if (!choice) return null;
  node.value = choice.value;
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
  return choice.text.trim();
}

/**
 * Runs inside the browser: scrolls the area of the page that holds the content (the largest
 * element that scrolls, else the page) by most of its height.
 */
export function scrollAgentPage(direction: 'down' | 'up'): void {
  let target: Element = document.scrollingElement ?? document.documentElement;
  let best = target.scrollHeight - target.clientHeight;
  for (const node of document.querySelectorAll<HTMLElement>('main, section, div, ul, table')) {
    const room = node.scrollHeight - node.clientHeight;
    if (
      room > best + 40 &&
      node.clientHeight > 150 &&
      /auto|scroll/.test(getComputedStyle(node).overflowY)
    ) {
      best = room;
      target = node;
    }
  }
  const step = Math.max(200, target.clientHeight * 0.8);
  target.scrollBy({ top: direction === 'down' ? step : -step, behavior: 'instant' });
}

/**
 * Runs inside the browser: scrolls to a control marked by `listAgentElements`, outlines it and
 * tells where to click. Null when the page changed and the control is gone.
 */
export function locateAgentElement(id: number): ExplorePoint | null {
  const node = document.querySelector<HTMLElement>('[data-adk-agent="' + id + '"]');
  if (!node) return null;
  node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const box = node.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  document.getElementById('adk-explore-mark')?.remove();
  const mark = document.createElement('div');
  mark.id = 'adk-explore-mark';
  mark.style.cssText =
    'position:fixed;box-sizing:border-box;pointer-events:none;z-index:2147483647;' +
    'border:2px solid #22c55e;border-radius:6px;box-shadow:0 0 0 3px rgba(34,197,94,.25);' +
    'left:' +
    (box.left - 3) +
    'px;top:' +
    (box.top - 3) +
    'px;width:' +
    (box.width + 6) +
    'px;height:' +
    (box.height + 6) +
    'px;';
  document.documentElement.appendChild(mark);
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/**
 * Runs inside the browser: whether the page shows a control or some text. A page that shows
 * neither is still loading (a splash screen of a single-page app).
 */
export function isRendered(): boolean {
  const controls = document.querySelectorAll(
    'a[href],button,input,select,textarea,[role="button"],[role="tab"],[role="menuitem"]',
  );
  for (const node of controls) {
    const rect = node.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
  }
  return (document.body?.innerText ?? '').trim().length > 120;
}

/**
 * Runs inside the browser: false while a loading mark (skeleton, spinner, progress bar) is on
 * screen. A screen with its menu already drawn is "rendered" long before its content arrives.
 */
export function isSettled(): boolean {
  const marks = document.querySelectorAll(
    '[aria-busy="true"],[role="progressbar"],[class*="skeleton" i],[class*="spinner" i],[class*="loader" i],[class*="loading" i]',
  );
  for (const node of marks) {
    const rect = node.getBoundingClientRect();
    if (rect.width > 1 && rect.height > 1 && node.checkVisibility({ visibilityProperty: true }))
      return false;
  }
  return true;
}

export interface ExplorePoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Runs inside the browser: where to click to type the account of the sign-in form on screen;
 * null when the page shows no password field.
 */
export function findSignInForm(): { user: ExplorePoint | null; password: ExplorePoint } | null {
  const visible = (node: Element) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && node.checkVisibility({ visibilityProperty: true });
  };
  const center = (node: Element): ExplorePoint => {
    node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  };
  const inputs = [...document.querySelectorAll('input')].filter(
    (node) => visible(node) && !node.disabled && !node.readOnly,
  );
  const password = inputs.find((node) => node.type === 'password');
  if (!password) return null;
  const scope = password.form ? inputs.filter((node) => node.form === password.form) : inputs;
  const user = scope
    .slice(0, scope.indexOf(password))
    .reverse()
    .find((node) => ['text', 'email', 'tel', ''].includes(node.type));
  return { user: user ? center(user) : null, password: center(password) };
}

/**
 * Runs inside the browser: optionally focuses (and selects the text of) the username or password
 * field of the sign-in form on screen, and reports what the fields hold. The password is only
 * reported by length.
 */
export function inspectSignIn(focus: 'user' | 'password' | null): {
  focused: boolean;
  user: string | null;
  passwordLength: number;
  /** Where the focused field is on screen. */
  point?: ExplorePoint;
} | null {
  const visible = (node: Element) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && node.checkVisibility({ visibilityProperty: true });
  };
  const inputs = [...document.querySelectorAll('input')].filter(
    (node) => visible(node) && !node.disabled && !node.readOnly,
  );
  const password = inputs.find((node) => node.type === 'password');
  if (!password) return null;
  const scope = password.form ? inputs.filter((node) => node.form === password.form) : inputs;
  const user = scope
    .slice(0, scope.indexOf(password))
    .reverse()
    .find((node) => ['text', 'email', 'tel', ''].includes(node.type));
  let focused = false;
  const target = focus === 'user' ? user : focus === 'password' ? password : null;
  if (target) {
    target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    target.focus();
    target.select();
    focused = document.activeElement === target;
  }
  const box = target?.getBoundingClientRect();
  return {
    focused,
    user: user ? user.value : null,
    passwordLength: password.value.length,
    ...(box ? { point: { x: box.left + box.width / 2, y: box.top + box.height / 2 } } : {}),
  };
}

/**
 * Runs inside the browser: the labels of the navigation controls of the site (menu items, tabs,
 * links), in page order and without repeats; never one that signs out or deletes.
 */
export function listNavAreas(origin: string): string[] {
  const risky =
    /log ?out|sign ?out|sair|encerrar|delete|remove|excluir|apagar|remover|unsubscribe|deactivate|desativar/i;
  const selector = [
    'nav a[href]',
    'nav button',
    'aside a[href]',
    'aside button',
    'header a[href]',
    '[role="navigation"] a[href]',
    '[role="navigation"] button',
    '[role="menubar"] [role="menuitem"]',
    '[role="tab"]',
  ].join(',');
  const labels: string[] = [];
  for (const node of document.querySelectorAll<HTMLElement>(selector)) {
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (!node.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    if (node.matches(':disabled,[aria-disabled="true"]')) continue;
    const label = (node.getAttribute('aria-label') || node.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    if (!label || risky.test(label) || labels.includes(label)) continue;
    if (node instanceof HTMLAnchorElement) {
      const raw = node.getAttribute('href') ?? '';
      if (raw.startsWith('#') || node.target === '_blank' || node.hasAttribute('download'))
        continue;
      if (!node.href.startsWith(origin)) continue;
    }
    labels.push(label);
    if (labels.length >= 40) break;
  }
  return labels;
}

/** Controls outside the focus an exploration may still click to find the area it was asked for. */
export const FOCUS_DETOURS = 3;

/** Whether a control (its label or address) names any keyword of the focus. */
export function matchesFocus(keywords: readonly string[], ...texts: string[]): boolean {
  const haystack = texts
    .join(' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword));
}

export interface ExploreTarget extends ExplorePoint {
  /** True when the control matches the focus the exploration was given. */
  readonly matched: boolean;
  /** Kind and name of the control; a target is clicked once per exploration. */
  readonly id: string;
  readonly label: string;
}

/**
 * Runs inside the browser: the next navigation control (menu item, tab, link of the site) the
 * exploration has not clicked yet, outlined on the page. Controls that sign out, delete or
 * leave the site are never offered.
 */
export function nextExploreTarget(options: {
  tried: readonly string[];
  origin: string;
  /** Words of the focus; controls naming one come first. Empty keeps the page order. */
  keywords?: readonly string[];
  /** How many controls outside the focus may still be offered. */
  detours?: number;
}): ExploreTarget | null {
  const risky =
    /log ?out|sign ?out|sair|encerrar|delete|remove|excluir|apagar|remover|unsubscribe|deactivate|desativar/i;
  const selector = [
    'nav a[href]',
    'nav button',
    'aside a[href]',
    'aside button',
    'header a[href]',
    '[role="navigation"] a[href]',
    '[role="navigation"] button',
    '[role="menubar"] [role="menuitem"]',
    '[role="tab"]',
    'a[href]',
  ].join(',');
  const tried = new Set(options.tried);
  const keywords = options.keywords ?? [];
  const plain = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  let best: { node: HTMLElement; id: string; label: string; matched: boolean } | null = null;
  for (const node of document.querySelectorAll<HTMLElement>(selector)) {
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (!node.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    if (node.matches(':disabled,[aria-disabled="true"]')) continue;
    const label = (node.getAttribute('aria-label') || node.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    if (!label || risky.test(label)) continue;
    let kind = node.getAttribute('role') === 'tab' ? 'tab' : 'button';
    if (node instanceof HTMLAnchorElement) {
      kind = 'link';
      const raw = node.getAttribute('href') ?? '';
      if (raw.startsWith('#') || node.target === '_blank' || node.hasAttribute('download'))
        continue;
      if (!node.href.startsWith(options.origin)) continue;
    }
    const id = kind + ':' + label;
    if (tried.has(id)) continue;
    const address = node instanceof HTMLAnchorElement ? node.getAttribute('href') || '' : '';
    const haystack = plain(label + ' ' + address);
    const matched = keywords.some((keyword) => haystack.includes(keyword));
    // Without a focus the first control wins; with one, the first control that names it.
    if (!keywords.length) {
      best = { node, id, label, matched: true };
      break;
    }
    if (matched) {
      best = { node, id, label, matched };
      break;
    }
    if (!best && (options.detours ?? 0) > 0) best = { node, id, label, matched };
  }
  if (best) {
    const { node, id, label, matched } = best;
    node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const box = node.getBoundingClientRect();
    document.getElementById('adk-explore-mark')?.remove();
    const mark = document.createElement('div');
    mark.id = 'adk-explore-mark';
    mark.style.cssText =
      'position:fixed;box-sizing:border-box;pointer-events:none;z-index:2147483647;' +
      'border:2px solid #22c55e;border-radius:6px;box-shadow:0 0 0 3px rgba(34,197,94,.25);' +
      'left:' +
      (box.left - 3) +
      'px;top:' +
      (box.top - 3) +
      'px;width:' +
      (box.width + 6) +
      'px;height:' +
      (box.height + 6) +
      'px;';
    document.documentElement.appendChild(mark);
    return { id, label, matched, x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }
  return null;
}

/** Runs inside the browser: removes the outline of the last explored control. */
export function clearExploreMark(): void {
  document.getElementById('adk-explore-mark')?.remove();
}

/**
 * Runs inside the browser: the virtual cursor of the evidence glides to a point (when given) and
 * the caption of the step shows at the bottom, like a person using the page. The layer stays on
 * the page, so the recording and every screenshot show where the agent is.
 */
export function moveExploreCursor(options: {
  x: number | null;
  y: number | null;
  label: string;
  glideMs: number;
  /** Only draws the layer again when a navigation dropped it. */
  restore?: boolean;
}): void {
  const state = window as unknown as { __adkCursor?: { x: number; y: number } };
  let layer = document.getElementById('adk-evidence-overlay');
  if (layer && options.restore) return;
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'adk-evidence-overlay';
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const style = document.createElement('style');
    style.textContent =
      '@keyframes adk-drop{0%{opacity:0;transform:translate(-50%,-50%) scale(2.6)}55%{opacity:1;transform:translate(-50%,-50%) scale(1)}100%{opacity:0;transform:translate(-50%,-50%) scale(.4)}}' +
      '@keyframes adk-wave{0%{opacity:.95;width:6px;height:6px;border-width:3px}100%{opacity:0;width:92px;height:92px;border-width:1px}}' +
      '@keyframes adk-press{0%,100%{transform:scale(1)}40%{transform:scale(.8)}}';
    layer.appendChild(style);
    const created = document.createElement('div');
    created.className = 'adk-cursor';
    created.style.cssText =
      'position:fixed;left:0;top:0;width:28px;height:28px;will-change:transform;display:none;' +
      'filter:drop-shadow(0 2px 3px rgba(0,0,0,.55));';
    created.innerHTML =
      '<svg width="28" height="28" viewBox="0 0 24 24" style="transform-origin:6px 4px"><path d="M5 3l14 7.2-6.2 1.6L9.6 18z" ' +
      'fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    layer.appendChild(created);
    document.documentElement.appendChild(layer);
  }
  for (const old of Array.from(layer.querySelectorAll('.adk-ripple,.adk-caption'))) old.remove();
  const arrow = layer.querySelector<HTMLElement>('.adk-cursor')!;
  const { x, y } = options;
  if (x !== null && y !== null) {
    const from = state.__adkCursor ?? { x: x + 140, y: y + 110 };
    arrow.style.display = 'block';
    arrow.style.transition = 'none';
    arrow.style.transform = 'translate(' + from.x + 'px,' + from.y + 'px)';
    void arrow.getBoundingClientRect();
    arrow.style.transition = 'transform ' + options.glideMs + 'ms cubic-bezier(.22,.8,.3,1)';
    arrow.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    state.__adkCursor = { x, y };
  }
  if (options.label) {
    const caption = document.createElement('div');
    caption.className = 'adk-caption';
    caption.textContent = options.label;
    caption.style.cssText =
      'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);max-width:70vw;' +
      'padding:6px 14px;border-radius:8px;background:rgba(17,17,17,.88);color:#fff;font:600 13px system-ui,sans-serif;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    layer.appendChild(caption);
  }
}

/**
 * Runs inside the browser: the cursor presses and a drop falls where the click lands: it hits the
 * page, sends out waves that widen and thin until they fade, and is gone.
 */
export function pressExploreCursor(): void {
  const state = window as unknown as { __adkCursor?: { x: number; y: number } };
  const layer = document.getElementById('adk-evidence-overlay');
  const at = state.__adkCursor;
  const svg = layer?.querySelector<SVGElement>('.adk-cursor svg');
  if (!layer || !at || !svg) return;
  svg.style.animation = 'none';
  void svg.getBoundingClientRect();
  svg.style.animation = 'adk-press 260ms ease-out';
  const ripple = document.createElement('div');
  ripple.className = 'adk-ripple';
  ripple.style.cssText = 'position:fixed;width:0;height:0;left:' + at.x + 'px;top:' + at.y + 'px;';
  const drop = document.createElement('div');
  drop.style.cssText =
    'position:absolute;left:0;top:0;width:12px;height:12px;border-radius:50%;background:#4ade80;' +
    'opacity:0;animation:adk-drop 260ms ease-in both;';
  ripple.appendChild(drop);
  for (let wave = 0; wave < 3; wave += 1) {
    const ring = document.createElement('div');
    ring.style.cssText =
      'position:absolute;left:0;top:0;box-sizing:border-box;border-radius:50%;border:3px solid #4ade80;' +
      'opacity:0;transform:translate(-50%,-50%);' +
      'animation:adk-wave 900ms ease-out ' +
      (200 + wave * 170) +
      'ms both;';
    ripple.appendChild(ring);
  }
  layer.appendChild(ripple);
  // Once the waves are gone the drop leaves nothing behind.
  setTimeout(() => ripple.remove(), 1_600);
}

/* v8 ignore stop */

export function runnerConfig(
  baseUrl: string,
  locale: string,
  protectedByAccess = false,
  localBrowserOrigin = false,
  browserArgs: readonly string[] = [],
  slowMo: number = SLOW_MO_MS,
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
    launchOptions: { slowMo: ${slowMo}${browserArgs.length ? `, args: ${JSON.stringify(browserArgs)}` : ''} },
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
      testStarted = Date.now();
      lastCursor = null;
      trackInspections(page);
      trackTouches(page);
      const live = startLive(page);
      const onRequest = (request: import('@playwright/test').Request) => {
        if (['document', 'xhr', 'fetch'].includes(request.resourceType())) pending.set(request, Date.now());
      };
      const onRequestDone = (request: import('@playwright/test').Request) => {
        pending.delete(request);
      };
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
      // A navigation drops the cursor layer: it is drawn again where the cursor stopped.
      const onLoaded = (loaded: import('@playwright/test').Page) => {
        if (!lastCursor) return;
        loaded
          .evaluate(playCursor, { mark: MARK, overlay: OVERLAY, click: false, label: lastCursor.label, glideMs: 0, at: lastCursor })
          .catch(() => undefined);
      };
      page.on('domcontentloaded', onLoaded);
      page.on('request', onRequest);
      page.on('requestfinished', onRequestDone);
      page.on('requestfailed', onRequestDone);
      page.on('response', onResponse);
      page.on('requestfailed', onRequestFailed);
      try {
        await use();
      } finally {
        clearInterval(live);
        page.off('domcontentloaded', onLoaded);
        page.off('request', onRequest);
        page.off('requestfinished', onRequestDone);
        page.off('requestfailed', onRequestDone);
        page.off('response', onResponse);
        page.off('requestfailed', onRequestFailed);
        pending.clear();
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
 * Before the screenshot, the elements the step asserted on are scrolled into view and
 * outlined, so each step's evidence shows what it verified instead of the same viewport.
 */
export function evidenceModule(mode: E2eMode, pace: E2ePaceSettings = PACES.recorded): string {
  const fixture = mode === 'frontend' ? UI_EVIDENCE_FIXTURE : 'accessBase';
  return String.raw`import { test as base, expect as baseExpect, type Locator, type Page, type APIRequestContext, type Route, type APIResponse } from '@playwright/test';
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
// Before Run and After Run are not steps of the test: their steps leave no evidence.
let phase: 'beforeRun' | 'test' | 'afterRun' = 'test';

export function setRunPhase(next: typeof phase): void {
  phase = next;
}

function recordBrowserDiagnostic(message: string): void {
  browserDiagnostics.push(message);
  if (browserDiagnostics.length > 8) browserDiagnostics.shift();
}

// Locators asserted on or read from during the current top-level step: its screenshot shows them.
const MARK = 'data-adk-evidence';
const OVERLAY = 'adk-evidence-overlay';
// Loading indicators still showing after a full settle are permanent page elements: ignored later.
const IDLE = 'data-adk-idle';
const BUSY = [
  '[aria-busy="true"]', '.spinner', '.spinner-border', '.spinner-grow', '.fa-spin', '.loading', '.loader',
  '.blockUI', '.blockOverlay', '.pace-running', 'ngx-spinner', 'ngx-loading', 'mat-spinner',
  'mat-progress-spinner', '.p-progress-spinner', '.ant-spin-spinning', '.MuiCircularProgress-root',
  '.MuiSkeleton-root', '[class*="spinner" i]', '[class*="loading" i]', '[class*="loader" i]', '[class*="skeleton" i]',
].join(', ');
const SETTLE_MS = 6000;
const QUIET_MS = 400;
const MAX_MARKED = 12;
/** How long the outlined evidence stays on the recording. */
const EVIDENCE_HOLD_MS = ${pace.evidenceHoldMs};
/** How long the virtual cursor takes to glide to an element before acting on it. */
const GLIDE_MS = ${pace.glideMs};
const VERBS: Record<string, string> = {
  click: 'Click', type: 'Type in', press: 'Press', check: 'Check', uncheck: 'Uncheck', select: 'Select in', hover: 'Hover over',
};
// Locator reads that show what a step checked even when the value is asserted afterwards.
const INSPECTIONS = [
  'evaluate', 'evaluateAll', 'textContent', 'innerText', 'innerHTML', 'inputValue', 'getAttribute',
  'isVisible', 'isChecked', 'isEnabled', 'isDisabled', 'isEditable', 'count', 'allTextContents',
  'allInnerTexts', 'boundingBox',
];
let asserted: Locator[] = [];
// Where the virtual cursor stopped, to draw it again after the page navigates.
let lastCursor: { x: number; y: number; label: string } | null = null;
let testStarted = 0;
// In-flight document/XHR/fetch requests of the page and when each started.
const pending = new Map<object, number>();

function rememberAsserted(value: unknown): void {
  if (depth === 0 || typeof value !== 'object' || value === null) return;
  const locator = value as Locator;
  if (typeof locator.page !== 'function' || typeof locator.evaluateAll !== 'function') return;
  asserted = asserted.filter((item) => item !== locator);
  asserted.push(locator);
  if (asserted.length > 6) asserted.shift();
}

const PATCHED = Symbol.for('adk.evidence.inspections');
// Locator methods as Playwright defines them, before they are wrapped.
const originals: Record<string, unknown> = {};

/** Makes locator reads count as evidence of the step, like the locators passed to expect. */
function trackInspections(page: Page): void {
  const prototype = Object.getPrototypeOf(page.locator('html')) as Record<string | symbol, unknown>;
  if (prototype[PATCHED]) return;
  prototype[PATCHED] = true;
  for (const name of INSPECTIONS) {
    const original = prototype[name];
    if (typeof original !== 'function') continue;
    originals[name] = original;
    prototype[name] = function (this: Locator, ...args: unknown[]) {
      rememberAsserted(this);
      return original.apply(this, args);
    };
  }
}

/** What is left of the limit before the test's own timeout, keeping room for teardown. */
function withinTimeout(limit: number): number {
  const timeout = extended.info().timeout;
  if (!timeout) return limit;
  return Math.max(0, Math.min(limit, timeout - (Date.now() - testStarted) - 10000));
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* Runs in the page: true once no loading indicator shows and the DOM stopped changing. With
   markIdle, flags the indicators still showing so later settles ignore them. */
function pageSettled(options: { busy: string; idle: string; quietMs: number; markIdle: boolean }): boolean {
  const state = window as unknown as { __adkLastMutation?: number };
  if (state.__adkLastMutation === undefined) {
    state.__adkLastMutation = performance.now();
    new MutationObserver(() => {
      state.__adkLastMutation = performance.now();
    }).observe(document, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'hidden', 'aria-busy'],
    });
  }
  const showing = Array.from(document.querySelectorAll(options.busy)).filter((node) => {
    if (node.closest('[' + options.idle + ']')) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 &&
      node.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  });
  if (options.markIdle) {
    for (const node of showing) node.setAttribute(options.idle, '');
    return true;
  }
  return document.readyState === 'complete' && showing.length === 0 &&
    performance.now() - (state.__adkLastMutation ?? 0) >= options.quietMs;
}

/** Waits, for a bounded time, until requests finish, loaders disappear and the DOM is stable. */
async function settle(page: Page): Promise<void> {
  const deadline = Date.now() + withinTimeout(SETTLE_MS);
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    const now = Date.now();
    // Long polling and streams never finish; only recent requests hold the evidence back.
    if ([...pending.values()].some((started) => now - started < 10000)) quietSince = now;
    else if (now - quietSince >= QUIET_MS) break;
    await pause(100);
  }
  const options = { busy: BUSY, idle: IDLE, quietMs: QUIET_MS, markIdle: false };
  try {
    await page.waitForFunction(pageSettled, options, {
      timeout: Math.max(deadline - Date.now(), 500),
      polling: 100,
    });
  } catch {
    await page.evaluate(pageSettled, { ...options, markIdle: true }).catch(() => undefined);
  }
}

/* Runs in the page: marks the visible elements of a locator and, when the first one is not
   fully visible (also inside scrolled tables and panels), scrolls it to the center. */
function markInspected(nodes: Element[], options: { mark: string; limit: number }): number {
  const shown = (node: Element) => {
    const rect = node.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return node;
    // Custom elements and wrappers with display: contents take the box of their content.
    for (const child of Array.from(node.children)) {
      const box = child.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) return child;
    }
    return null;
  };
  const visibleArea = (node: Element) => {
    const rect = node.getBoundingClientRect();
    let left = Math.max(rect.left, 0);
    let top = Math.max(rect.top, 0);
    let right = Math.min(rect.right, innerWidth);
    let bottom = Math.min(rect.bottom, innerHeight);
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const box = parent.getBoundingClientRect();
      left = Math.max(left, box.left);
      top = Math.max(top, box.top);
      right = Math.min(right, box.right);
      bottom = Math.min(bottom, box.bottom);
    }
    const full = rect.width * rect.height;
    return full ? (Math.max(0, right - left) * Math.max(0, bottom - top)) / full : 0;
  };
  let marked = 0;
  for (const node of nodes) {
    if (marked >= options.limit) break;
    const target = shown(node);
    if (!target || !target.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    if (marked === 0 && visibleArea(target) < 0.9)
      target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    target.setAttribute(options.mark, '');
    marked += 1;
  }
  return marked;
}

/* Runs in the page: a virtual cursor glides to the marked elements,
   rings it and, for a click, presses with a ripple, like a person using the page. The layer
   stays on the page so the next move starts where the cursor stopped. */
function playCursor(options: { mark: string; overlay: string; click: boolean; label: string; glideMs: number; at?: { x: number; y: number } }): { x: number; y: number } | null {
  const clipped = (target: Element) => {
    const rect = target.getBoundingClientRect();
    let left = Math.max(rect.left, 0);
    let top = Math.max(rect.top, 0);
    let right = Math.min(rect.right, innerWidth);
    let bottom = Math.min(rect.bottom, innerHeight);
    for (let parent = target.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const box = parent.getBoundingClientRect();
      left = Math.max(left, box.left);
      top = Math.max(top, box.top);
      right = Math.min(right, box.right);
      bottom = Math.min(bottom, box.bottom);
    }
    return right > left && bottom > top ? { left, top, right, bottom } : null;
  };
  // A restore draws the cursor again where it stopped, after a navigation dropped the layer.
  const targets = options.at ? [] : Array.from(document.querySelectorAll('[' + options.mark + ']'));
  if (!targets.length && !options.at) return null;
  // Scrolls to the first target only when none of them is showing: one that already is (the
  // element the step read last, scrolled to when it was marked) must not be scrolled away again.
  if (targets.length && !targets.some((target) => clipped(target) !== null))
    targets[0].scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const boxes = targets.map(clipped).filter((box): box is NonNullable<typeof box> => box !== null);
  // Consumed: the next move must only see its own targets.
  for (const target of targets) target.removeAttribute(options.mark);
  if (!boxes.length && !options.at) return null;
  const state = window as unknown as { __adkCursor?: { x: number; y: number } };
  let layer = document.getElementById(options.overlay);
  if (!layer) {
    layer = document.createElement('div');
    layer.id = options.overlay;
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const style = document.createElement('style');
    style.textContent =
      '@keyframes adk-ring{0%{opacity:0;transform:scale(1.18)}100%{opacity:1;transform:scale(1)}}' +
      '@keyframes adk-drop{0%{opacity:0;transform:translate(-50%,-50%) scale(2.6)}55%{opacity:1;transform:translate(-50%,-50%) scale(1)}100%{opacity:0;transform:translate(-50%,-50%) scale(.4)}}' +
      '@keyframes adk-wave{0%{opacity:.95;width:6px;height:6px;border-width:3px}100%{opacity:0;width:92px;height:92px;border-width:1px}}' +
      '@keyframes adk-press{0%,100%{transform:scale(1)}40%{transform:scale(.8)}}';
    layer.appendChild(style);
    const arrow = document.createElement('div');
    arrow.className = 'adk-cursor';
    arrow.style.cssText = 'position:fixed;left:0;top:0;width:28px;height:28px;will-change:transform;' +
      'filter:drop-shadow(0 2px 3px rgba(0,0,0,.55));';
    arrow.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" style="transform-origin:6px 4px"><path d="M5 3l14 7.2-6.2 1.6L9.6 18z" ' +
      'fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    layer.appendChild(arrow);
    document.documentElement.appendChild(layer);
  }
  for (const old of Array.from(layer.querySelectorAll('.adk-ring,.adk-ripple,.adk-caption'))) old.remove();
  const first = boxes[0];
  const x = options.at ? options.at.x : first.left + Math.min((first.right - first.left) / 2, 160);
  const y = options.at ? options.at.y : first.top + (first.bottom - first.top) / 2;
  const arrow = layer.querySelector('.adk-cursor') as HTMLElement;
  const from = options.at ? options.at : state.__adkCursor ?? { x: x + 140, y: y + 110 };
  arrow.style.transition = 'none';
  arrow.style.transform = 'translate(' + from.x + 'px,' + from.y + 'px)';
  void arrow.getBoundingClientRect();
  arrow.style.transition = 'transform ' + options.glideMs + 'ms cubic-bezier(.22,.8,.3,1)';
  arrow.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  state.__adkCursor = { x, y };
  for (const box of boxes) {
    const ring = document.createElement('div');
    ring.className = 'adk-ring';
    ring.style.cssText = 'position:fixed;box-sizing:border-box;border:2px solid #4ade80;border-radius:8px;' +
      'background:rgba(74,222,128,.12);box-shadow:0 0 0 3px rgba(74,222,128,.28),0 0 18px rgba(74,222,128,.45);' +
      'animation:adk-ring ' + options.glideMs + 'ms ease-out both;' +
      'left:' + (box.left - 4) + 'px;top:' + (box.top - 4) + 'px;width:' + (box.right - box.left + 8) + 'px;height:' + (box.bottom - box.top + 8) + 'px;';
    layer.appendChild(ring);
  }
  if (options.label) {
    const caption = document.createElement('div');
    caption.className = 'adk-caption';
    caption.textContent = options.label;
    caption.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);max-width:70vw;' +
      'padding:6px 14px;border-radius:8px;background:rgba(17,17,17,.88);color:#fff;font:600 13px system-ui,sans-serif;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    layer.appendChild(caption);
  }
  if (options.click) {
    setTimeout(() => {
      const svg = arrow.firstElementChild as SVGElement | null;
      if (svg) svg.style.animation = 'adk-press 260ms ease-out';
      // A drop falls on the page, sends out waves that widen, thin and fade, and is gone.
      const ripple = document.createElement('div');
      ripple.className = 'adk-ripple';
      ripple.style.cssText = 'position:fixed;width:0;height:0;left:' + x + 'px;top:' + y + 'px;';
      const drop = document.createElement('div');
      drop.style.cssText = 'position:absolute;left:0;top:0;width:12px;height:12px;border-radius:50%;background:#4ade80;' +
        'opacity:0;animation:adk-drop 260ms ease-in both;';
      ripple.appendChild(drop);
      for (let wave = 0; wave < 3; wave += 1) {
        const ripplering = document.createElement('div');
        ripplering.style.cssText = 'position:absolute;left:0;top:0;box-sizing:border-box;border-radius:50%;border:3px solid #4ade80;' +
          'opacity:0;transform:translate(-50%,-50%);animation:adk-wave 900ms ease-out ' + (200 + wave * 170) + 'ms both;';
        ripple.appendChild(ripplering);
      }
      layer?.appendChild(ripple);
      setTimeout(() => ripple.remove(), 1600);
    }, options.glideMs);
  }
  return { x, y };
}

/* Runs in the page: removes the rings and the caption; the cursor stays where it stopped. */
function clearEvidence(options: { mark: string; overlay: string }): void {
  document.getElementById(options.overlay)?.querySelectorAll('.adk-ring,.adk-ripple,.adk-caption')
    .forEach((item) => item.remove());
  for (const node of Array.from(document.querySelectorAll('[' + options.mark + ']'))) node.removeAttribute(options.mark);
}

function tracked<T extends object>(target: T): T {
  return new Proxy(target, {
    apply: (fn, thisArg, args: unknown[]) => {
      rememberAsserted(args[0]);
      return Reflect.apply(fn as (...items: unknown[]) => unknown, thisArg, args);
    },
  });
}

export const expect = new Proxy(tracked(baseExpect), {
  get: (target, property, receiver) => {
    const value = Reflect.get(target, property, receiver);
    return property === 'soft' && typeof value === 'function' ? tracked(value) : value;
  },
});

/** Scrolls to the asserted elements and boxes them; false when none of them is showing. */
async function highlightAsserted(page: Page): Promise<boolean> {
  let marked = 0;
  for (const locator of asserted) {
    try {
      if (locator.page() !== page) continue;
      marked += await locator.evaluateAll(markInspected, { mark: MARK, limit: MAX_MARKED });
    } catch {
      // An element that detached or never rendered is left out of the evidence.
    }
  }
  if (!marked) return false;
  for (const frame of page.frames())
    await frame
      .evaluate(playCursor, { mark: MARK, overlay: OVERLAY, click: false, label: '', glideMs: GLIDE_MS })
      .catch(() => undefined);
  await pause(withinTimeout(GLIDE_MS + 100));
  return true;
}

async function clearHighlight(page: Page): Promise<void> {
  for (const frame of page.frames())
    await frame.evaluate(clearEvidence, { mark: MARK, overlay: OVERLAY }).catch(() => undefined);
}

// --- Action trail: the screens and elements the test touched, for the run's action map. ---
const TOUCHES: Record<string, string> = {
  click: 'click', dblclick: 'click', tap: 'click', fill: 'type', type: 'type',
  pressSequentially: 'type', press: 'press', check: 'check', uncheck: 'uncheck',
  setChecked: 'check', selectOption: 'select', hover: 'hover',
};
const TOUCH_PATCHED = Symbol.for('adk.evidence.touches');
const MAX_TRAIL_PAGES = 20;
const MAX_TRAIL_ELEMENTS = 40;
const MAX_TOUCHES = 300;
const trailPages = new Map<string, number>();
const trailElements = new Map<string, number>();
let lastTrailPage = 0;
let touchCount = 0;
let touchDepth = 0;

function appendTrail(entry: unknown): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.appendFileSync(path.join(directory, 'trail.jsonl'), JSON.stringify(entry) + '\n');
}

async function trailShot(page: Page, file: string): Promise<string | null> {
  try {
    fs.mkdirSync(directory, { recursive: true });
    await page.screenshot({
      path: path.join(directory, file), type: 'jpeg', quality: 50, timeout: 4000, caret: 'initial',
    });
    return file;
  } catch {
    return null;
  }
}

/* Runs in the page: the title and first visible heading, which tell the screens of an SPA apart. */
function describeScreen(): { title: string; heading: string } {
  const clean = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  let heading = '';
  for (const node of Array.from(document.querySelectorAll('h1,h2,[role="heading"]'))) {
    const rect = node.getBoundingClientRect();
    // Headings kept only for screen readers are 1px boxes and name the application, not the screen.
    if (rect.width > 1 && rect.height > 1 && node.checkVisibility({ visibilityProperty: true }) && clean(node.textContent)) {
      heading = clean(node.textContent);
      break;
    }
  }
  return { title: clean(document.title), heading };
}

/** Registers the screen the test is on; 0 when it cannot be read or the trail is full. */
async function notePage(page: Page): Promise<number> {
  const url = page.url();
  if (!/^https?:/.test(url)) return 0;
  const screen = await page.evaluate(describeScreen).catch(() => null);
  if (!screen) return 0;
  const title = screen.heading || screen.title;
  const parsed = new URL(url);
  const key = parsed.pathname + parsed.search + ' | ' + title;
  let index = trailPages.get(key);
  if (index === undefined) {
    if (trailPages.size >= MAX_TRAIL_PAGES) return 0;
    index = trailPages.size + 1;
    trailPages.set(key, index);
    appendTrail({ type: 'page', index, url, title, screenshot: await trailShot(page, 'trail-page-' + index + '.jpg') });
  }
  if (index !== lastTrailPage) {
    lastTrailPage = index;
    appendTrail({ type: 'visit', index });
  }
  return index;
}

interface TouchedElement {
  kind: string;
  name: string;
  secret: boolean;
  box: { x: number; y: number; width: number; height: number } | null;
}

/* Runs in the page: what kind of control the element is, how it is called and where it is. */
function describeTouched(node: Element): TouchedElement {
  const clean = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const tag = node.tagName.toLowerCase();
  const role = node.getAttribute('role') || '';
  const type = (node.getAttribute('type') || '').toLowerCase();
  let kind = 'element';
  if (role === 'tab') kind = 'tab';
  else if (role === 'menuitem' || role === 'option') kind = 'option';
  else if (type === 'checkbox' || role === 'checkbox' || role === 'switch') kind = 'checkbox';
  else if (type === 'radio' || role === 'radio') kind = 'radio';
  else if (tag === 'a' || role === 'link') kind = 'link';
  else if (tag === 'button' || role === 'button' || type === 'submit' || type === 'button') kind = 'button';
  else if (tag === 'select' || role === 'combobox' || role === 'listbox') kind = 'select';
  else if (tag === 'input' || tag === 'textarea' || (node as HTMLElement).isContentEditable) kind = 'field';
  const id = node.getAttribute('id');
  const label = (id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null) || node.closest('label');
  // The text of a field or a list is its content, not its name.
  const ownText = kind === 'field' || kind === 'select' ? '' : clean(node.textContent);
  const name = clean(node.getAttribute('aria-label')) || clean(label ? label.textContent : '') ||
    clean(node.getAttribute('placeholder')) || ownText || clean(node.getAttribute('title')) ||
    clean(node.getAttribute('name'));
  const rect = node.getBoundingClientRect();
  const box = rect.width > 0 && rect.height > 0 && innerWidth > 0 && innerHeight > 0
    ? {
        x: Math.min(1, Math.max(0, rect.left / innerWidth)),
        y: Math.min(1, Math.max(0, rect.top / innerHeight)),
        width: Math.min(1, rect.width / innerWidth),
        height: Math.min(1, rect.height / innerHeight),
      }
    : null;
  return { kind, name, secret: type === 'password', box };
}

/** Glides the virtual cursor to the element the test is about to act on, so the recording shows it. */
async function showCursor(locator: Locator, page: Page, action: string, name: string): Promise<void> {
  try {
    const evaluate = (originals.evaluate || locator.evaluate) as (...items: unknown[]) => Promise<unknown>;
    await evaluate.call(locator, (node: Element, mark: string) => node.setAttribute(mark, ''), MARK, { timeout: 2500 });
    const label = '#' + (depth > 0 ? position : 0) + ' ' + (VERBS[action] || 'Act on') + (name ? ' "' + name + '"' : '');
    const options = {
      mark: MARK, overlay: OVERLAY, label, glideMs: GLIDE_MS,
      click: ['click', 'check', 'uncheck', 'type', 'select'].includes(action),
    };
    for (const frame of page.frames()) {
      const at = await frame.evaluate(playCursor, options).catch(() => null);
      if (at && frame === page.mainFrame()) lastCursor = { x: at.x, y: at.y, label };
    }
    if (GLIDE_MS > 0) await pause(withinTimeout(GLIDE_MS + 150));
  } catch {
    // The cursor is decoration: the action runs anyway.
  }
}

/** Adds an action of the test to its trail, with the screen and the element it acts on. */
async function recordTouch(locator: Locator, method: string, args: unknown[]): Promise<void> {
  if (phase !== 'test' || touchCount >= MAX_TOUCHES) return;
  const action = TOUCHES[method];
  const page = locator.page();
  if (page.isClosed()) return;
  const first = locator.first();
  // The original evaluate: the patched one would turn every touched element into step evidence.
  const evaluate = (originals.evaluate || first.evaluate) as (...items: unknown[]) => Promise<TouchedElement>;
  const info = await evaluate.call(first, describeTouched, undefined, { timeout: 2500 }).catch(() => null);
  await showCursor(first, page, action, info ? info.name : '');
  const pageIndex = await notePage(page);
  let elementIndex: number | null = null;
  if (info && pageIndex) {
    const key = pageIndex + ' | ' + info.kind + ' | ' + info.name;
    const known = trailElements.get(key);
    if (known !== undefined) elementIndex = known;
    else if (trailElements.size < MAX_TRAIL_ELEMENTS) {
      elementIndex = trailElements.size + 1;
      trailElements.set(key, elementIndex);
      appendTrail({
        type: 'element', index: elementIndex, pageIndex, kind: info.kind, name: info.name, box: info.box,
        screenshot: await trailShot(page, 'trail-element-' + elementIndex + '.jpg'),
      });
    }
  }
  let value: string | null = null;
  if (action === 'type' || action === 'press' || action === 'select') {
    const raw = typeof args[0] === 'string' ? args[0] : null;
    const password = process.env.E2E_PASSWORD || '';
    if (raw !== null) value = (info && info.secret) || (password && raw === password) ? '******' : raw.slice(0, 200);
  }
  touchCount += 1;
  const step = depth > 0 ? position : 0;
  appendTrail({ type: 'touch', atMs: Date.now() - testStarted, step, action, pageIndex, elementIndex, value });
  fs.writeFileSync(
    path.join(directory, 'live.json'),
    JSON.stringify({ step, action, kind: info ? info.kind : 'element', name: info ? info.name : '' }),
  );
}

const PAGE_TOUCH_PATCHED = Symbol.for('adk.evidence.page-touches');

/** Page.click(selector), page.fill(selector, value)...: the same trail and cursor as the locator actions. */
function trackPageTouches(page: Page): void {
  const prototype = Object.getPrototypeOf(page) as Record<string | symbol, unknown>;
  if (prototype[PAGE_TOUCH_PATCHED]) return;
  prototype[PAGE_TOUCH_PATCHED] = true;
  for (const name of Object.keys(TOUCHES)) {
    const original = prototype[name];
    if (typeof original !== 'function') continue;
    prototype[name] = async function (this: Page, ...args: unknown[]) {
      const [selector, ...rest] = args;
      if (touchDepth > 0 || typeof selector !== 'string') return original.apply(this, args);
      await recordTouch(this.locator(selector), name, rest).catch(() => undefined);
      touchDepth += 1;
      try {
        return await original.apply(this, args);
      } finally {
        touchDepth -= 1;
      }
    };
  }
}

/** Makes the locator actions of the test (click, fill, check...) leave their trail. */
function trackTouches(page: Page): void {
  trackPageTouches(page);
  const prototype = Object.getPrototypeOf(page.locator('html')) as Record<string | symbol, unknown>;
  if (prototype[TOUCH_PATCHED]) return;
  prototype[TOUCH_PATCHED] = true;
  for (const name of Object.keys(TOUCHES)) {
    const original = prototype[name];
    if (typeof original !== 'function') continue;
    prototype[name] = async function (this: Locator, ...args: unknown[]) {
      // Actions Playwright implements through other actions count once.
      if (touchDepth > 0) return original.apply(this, args);
      await recordTouch(this, name, args).catch(() => undefined);
      touchDepth += 1;
      try {
        return await original.apply(this, args);
      } finally {
        touchDepth -= 1;
      }
    };
  }
}

/** Keeps a recent frame of the page on disk while the test runs, for the live view of the run. */
function startLive(page: Page): ReturnType<typeof setInterval> {
  const file = path.join(directory, 'live.jpg');
  let busy = false;
  return setInterval(() => {
    if (busy || page.isClosed()) return;
    busy = true;
    fs.mkdirSync(directory, { recursive: true });
    page
      .screenshot({ path: file + '.tmp', type: 'jpeg', quality: 45, timeout: 3000, caret: 'initial' })
      .then(() => fs.renameSync(file + '.tmp', file))
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, 1500);
}

const extended = ${fixture};
type StepBody = (...args: unknown[]) => unknown;
const runStep = extended.step as unknown as (title: string, body: StepBody, options?: unknown) => Promise<unknown>;

async function step(title: string, body: StepBody, options?: unknown): Promise<unknown> {
  // Nested steps belong to the evidence of the top-level step that contains them.
  if (depth > 0 || phase !== 'test') return runStep(title, body, options);
  depth += 1;
  browserDiagnostics = [];
  asserted = [];
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
      const page = currentPage;
      const file = 'step-' + String(index).padStart(2, '0') + '.png';
      // The step may end on a navigation or a request still loading its data.
      await settle(page);
      const highlighted = await highlightAsserted(page);
      try {
        await page.screenshot({ path: path.join(directory, file), timeout: 5000, animations: 'disabled' });
        screenshot = file;
      } catch {
        // Evidence is best effort; the outcome of the step is still recorded.
      }
      if (highlighted && EVIDENCE_HOLD_MS > 0) await pause(withinTimeout(EVIDENCE_HOLD_MS));
      await clearHighlight(page);
      // The step may have ended on a screen no action touched yet.
      await notePage(page).catch(() => undefined);
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

type HookKind = keyof typeof HOOK_MODULES;

/** The Before Run and After Run of the input that have code; blank ones are skipped. */
export function presentHooks(input: Pick<E2eRunInput, 'hooks'>): Partial<Record<HookKind, string>> {
  const hooks: Partial<Record<HookKind, string>> = {};
  for (const kind of Object.keys(HOOK_MODULES) as HookKind[]) {
    const content = input.hooks?.[kind];
    if (content?.trim()) hooks[kind] = content;
  }
  return hooks;
}

/**
 * Appended to the spec at run time (never pushed to the repository): calls Before Run before
 * the test and After Run after it, even when the test or Before Run failed, so the data they
 * created is always removed. Their steps leave no evidence and their errors name the phase.
 * API tests get only `request`, so no browser starts for them.
 */
export function withHooks(
  script: string,
  hooks: Partial<Record<HookKind, string>>,
  mode: E2eMode,
): string {
  const kinds = (Object.keys(HOOK_MODULES) as HookKind[]).filter((kind) => hooks[kind]);
  if (!kinds.length) return script;
  const fixtures = mode === 'frontend' ? '{ page, request }' : '{ request }';
  const calls = kinds.map((kind) => {
    const hook = kind === 'beforeRun' ? 'beforeEach' : 'afterEach';
    const label = kind === 'beforeRun' ? 'Before Run' : 'After Run';
    return `__adkHooks.${hook}(async (${fixtures}, testInfo) => {
  testInfo.setTimeout(testInfo.timeout + ${HOOK_TIMEOUT_MS});
  __adkSetRunPhase(${JSON.stringify(kind)});
  try {
    await __adk_${kind}(${fixtures});
  } catch (error) {
    if (error instanceof Error) error.message = ${JSON.stringify(`${label}: `)} + error.message;
    throw error;
  } finally {
    __adkSetRunPhase('test');
  }
});`;
  });
  return `${script}

import { test as __adkHooks, setRunPhase as __adkSetRunPhase } from './${EVIDENCE_MODULE}';
${kinds.map((kind) => `import __adk_${kind} from './${HOOK_MODULES[kind]}';`).join('\n')}
${calls.join('\n')}
`;
}

/**
 * Appended to UI specs at run time (never pushed to the repository): keeps the page open
 * after the last step, passed or failed, so the video ends on the final screen instead of
 * being cut when the context closes.
 */
export function withRecordingHold(
  script: string,
  mode: E2eMode,
  holdMs: number = FINAL_HOLD_MS,
): string {
  if (mode !== 'frontend') return script;
  return `${script}

import { test as __adkRecording } from '@playwright/test';
__adkRecording.afterEach(async ({ page }) => {
  await page.waitForTimeout(${holdMs}).catch(() => undefined);
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
  for (const [key, value] of Object.entries(input.variables ?? {}))
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) env[`E2E_VAR_${key}`] = value;
  for (const key of ['SystemRoot', 'windir', 'COMSPEC', 'PATHEXT']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  // The desktop app runs this server on Electron's Node (ELECTRON_RUN_AS_NODE) and the runner
  // starts Playwright with process.execPath: without the flag the child would open the Electron
  // app itself and end without any output.
  if (process.versions['electron']) env['ELECTRON_RUN_AS_NODE'] = '1';
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

/**
 * Closes the recorded browsers, which writes their videos, and reports each one that is not too
 * big. A recording that cannot be read only costs that video; the folder is always removed.
 */
async function sendRecordings(
  recorded: readonly { worker: number; page: BrowserPage }[],
  directory: string,
  emit: (event: E2eExploreEvent) => void,
): Promise<void> {
  for (const { worker, page } of recorded) {
    try {
      const video = page.video?.();
      await page.close?.();
      const file = await video?.path();
      if (!file) continue;
      const content = await fs.readFile(file);
      if (content.byteLength > 0 && content.byteLength <= MAX_VIDEO_BYTES)
        emit({ kind: 'video', worker, video: content });
    } catch {
      // The exploration is done; a video that was not written is simply not shown.
    }
  }
  await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
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

const TRAIL_PAGE_FILE = /^trail-page-\d+\.jpg$/;
const TRAIL_ELEMENT_FILE = /^trail-element-\d+\.jpg$/;
const TOUCH_ACTIONS: readonly string[] = [
  'click',
  'type',
  'press',
  'check',
  'uncheck',
  'select',
  'hover',
];

interface TrailLine {
  readonly type?: unknown;
  readonly index?: unknown;
  readonly pageIndex?: unknown;
  readonly elementIndex?: unknown;
  readonly url?: unknown;
  readonly title?: unknown;
  readonly kind?: unknown;
  readonly name?: unknown;
  readonly box?: unknown;
  readonly screenshot?: unknown;
  readonly atMs?: unknown;
  readonly step?: unknown;
  readonly action?: unknown;
  readonly value?: unknown;
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;

function trailBox(value: unknown): E2eTrailElement['box'] {
  const box = (value ?? {}) as Record<string, unknown>;
  const parts = [box['x'], box['y'], box['width'], box['height']];
  if (!parts.every((part) => typeof part === 'number' && part >= 0 && part <= 1)) return null;
  const [x, y, width, height] = parts as number[];
  return { x: x!, y: y!, width: width!, height: height! };
}

/**
 * Reads the trail the evidence module recorded: the screens the test went through, the elements
 * it acted on and each action. Null when the test touched nothing (or never reached a page).
 */
export async function readTrail(
  directory: string,
  secrets: readonly (string | null)[],
): Promise<E2eTrail | null> {
  let content: string;
  try {
    content = await fs.readFile(path.join(directory, 'trail.jsonl'), 'utf8');
  } catch {
    return null;
  }
  const image = async (name: unknown, pattern: RegExp): Promise<Uint8Array | null> => {
    if (typeof name !== 'string' || !pattern.test(name)) return null;
    const file = await fs.readFile(path.join(directory, name)).catch(() => null);
    return file && file.byteLength <= MAX_SCREENSHOT_BYTES ? file : null;
  };
  const text = (value: unknown, max: number) =>
    redact(typeof value === 'string' ? value : '', secrets).slice(0, max);
  const pages: E2eTrailPage[] = [];
  const elements: E2eTrailElement[] = [];
  const touches: E2eTrailTouch[] = [];
  const visits: number[] = [];
  for (const line of content.split('\n')) {
    let entry: TrailLine | null;
    try {
      entry = JSON.parse(line) as TrailLine | null;
    } catch {
      continue;
    }
    const index = count(entry?.index);
    if (entry?.type === 'page' && index)
      pages.push({
        index,
        url: text(entry.url, 2_000),
        title: text(entry.title, 200),
        screenshot: await image(entry.screenshot, TRAIL_PAGE_FILE),
      });
    else if (entry?.type === 'visit' && index) visits.push(index);
    else if (entry?.type === 'element' && index)
      elements.push({
        index,
        pageIndex: count(entry.pageIndex),
        kind: text(entry.kind, 30) || 'element',
        name: text(entry.name, 200),
        box: trailBox(entry.box),
        screenshot: await image(entry.screenshot, TRAIL_ELEMENT_FILE),
      });
    else if (entry?.type === 'touch' && TOUCH_ACTIONS.includes(entry.action as string))
      touches.push({
        atMs: typeof entry.atMs === 'number' ? entry.atMs : 0,
        step: count(entry.step),
        action: entry.action as E2eTrailTouch['action'],
        pageIndex: count(entry.pageIndex),
        elementIndex: count(entry.elementIndex) || null,
        value: typeof entry.value === 'string' ? text(entry.value, 200) : null,
      });
  }
  return pages.length ? { pages, elements, touches, visits } : null;
}

async function readActivity(directory: string): Promise<E2eLiveActivity | null> {
  try {
    const entry = JSON.parse(
      await fs.readFile(path.join(directory, 'live.json'), 'utf8'),
    ) as TrailLine;
    if (!TOUCH_ACTIONS.includes(entry.action as string)) return null;
    return {
      step: count(entry.step),
      action: entry.action as E2eLiveActivity['action'],
      kind: typeof entry.kind === 'string' ? entry.kind.slice(0, 30) : 'element',
      name: typeof entry.name === 'string' ? entry.name.slice(0, 200) : '',
    };
  } catch {
    return null;
  }
}

/**
 * Follows the frame a running UI test keeps on disk and hands each new one to the listener.
 * Returns the function that stops following.
 */
export function watchLive(
  directory: string,
  intervalMs: number,
  onLive: (frame: E2eLiveFrame) => void,
): () => void {
  let seen = 0;
  const read = async () => {
    // One handle for the stat and the read, so the frame cannot be swapped in between.
    const handle = await fs.open(path.join(directory, 'live.jpg'), 'r');
    try {
      const { mtimeMs } = await handle.stat();
      if (mtimeMs === seen) return;
      seen = mtimeMs;
      onLive({ image: await handle.readFile(), activity: await readActivity(directory) });
    } finally {
      await handle.close();
    }
  };
  // No frame yet, a frame being replaced or a failing listener: the next tick tries again.
  const timer = setInterval(() => void read().catch(noop), intervalMs);
  return () => clearInterval(timer);
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
