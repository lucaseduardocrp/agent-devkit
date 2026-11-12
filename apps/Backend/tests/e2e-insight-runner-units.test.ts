import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  PlaywrightE2eRunner,
  THOROUGH_EXPLORE_LIMITS,
  clearExploreMark,
  collectPageSnapshot,
  findSignInForm,
  matchesFocus,
  nextExploreTarget,
  pageKey,
  pageName,
  readTrail,
  watchLive,
  type PlaywrightModule,
  type ProcessExecutor,
} from '../src/modules/e2e/adapters/playwright-runner.js';
import {
  focusKeywords,
  type E2eExploreEvent,
  type E2eLiveFrame,
  type E2ePageSnapshot,
} from '../src/modules/e2e/application/e2e-runner.js';

const ORIGIN = 'http://app.test';

function snap(
  title: string,
  options: { headings?: string[]; links?: string[]; url?: string } = {},
): E2ePageSnapshot {
  return {
    url: options.url ?? `${ORIGIN}/`,
    title,
    headings: options.headings ?? [title],
    buttons: [],
    fields: [],
    testIds: [],
    links: (options.links ?? []).map((href) => ({ text: href, href })),
  };
}

interface FakeOptions {
  snapshots: (E2ePageSnapshot | Error)[];
  form?: unknown;
  targets?: unknown[];
  screenshot?: (() => Promise<Uint8Array>) | false;
  mouse?: boolean;
  keyboard?: boolean;
  url?: (() => string) | false;
}

function fakeBrowser(options: FakeOptions) {
  const targets = [...(options.targets ?? [])];
  const calls: string[] = [];
  const page = {
    goto: vi.fn(async (target: string) => {
      calls.push(`goto:${target}`);
    }),
    waitForLoadState: vi.fn().mockRejectedValue(new Error('still loading')),
    evaluate: vi.fn(async (fn: unknown) => {
      if (fn === collectPageSnapshot) {
        const next = options.snapshots.shift();
        if (next instanceof Error || !next) throw next ?? new Error('no page');
        return next;
      }
      if (fn === findSignInForm) {
        if (options.form instanceof Error) throw options.form;
        return options.form ?? null;
      }
      if (fn === nextExploreTarget) {
        const next = targets.shift();
        if (next instanceof Error) throw next;
        return next ?? null;
      }
      expect(fn).toBe(clearExploreMark);
      return undefined;
    }),
    ...(options.screenshot === false
      ? {}
      : {
          screenshot: vi.fn(options.screenshot ?? (() => Promise.resolve(Buffer.from('jpeg')))),
        }),
    ...(options.mouse === false
      ? {}
      : {
          mouse: {
            click: vi.fn(async (x: number) => {
              calls.push(`click:${x}`);
              if (x < 0) throw new Error('page closed');
            }),
          },
        }),
    ...(options.keyboard === false
      ? {}
      : {
          keyboard: {
            type: vi.fn(async (text: string) => {
              calls.push(`type:${text}`);
            }),
            press: vi.fn(async (key: string) => {
              calls.push(`press:${key}`);
            }),
          },
        }),
    ...(options.url === false ? {} : { url: vi.fn(options.url ?? (() => `${ORIGIN}/`)) }),
  };
  const loadPlaywright = () =>
    Promise.resolve({
      chromium: {
        launch: () =>
          Promise.resolve({ newPage: () => Promise.resolve(page), close: () => Promise.resolve() }),
      },
    } as unknown as PlaywrightModule);
  return { page, calls, loadPlaywright };
}

const account = { username: 'qa@example.com', password: 'pw-secret' };
const target = (label: string, x = 10) => ({ id: `button:${label}`, label, x, y: 5 });

describe('exploring a UI by signing in and clicking through it (fake browser)', () => {
  it('signs in, follows links, clicks each target once and reports every step', async () => {
    let outside = false;
    const { calls, loadPlaywright } = fakeBrowser({
      snapshots: [
        snap('Sign in', { links: [`${ORIGIN}/about`] }),
        snap('Home'), // read right after the sign-in, for the log
        snap('Home', { links: [`${ORIGIN}/about`] }),
        snap('About', { url: `${ORIGIN}/about` }),
        snap('Issues'),
        snap('Home'), // a screen already captured is not captured twice
      ],
      form: { user: { x: 1, y: 2 }, password: { x: 3, y: 4 } },
      targets: [target('Issues'), target('Broken', -1), target('Docs', 30)],
      url: () => {
        const result = outside ? 'https://elsewhere.test/docs' : `${ORIGIN}/`;
        outside = calls.at(-1) === 'click:30';
        return result;
      },
    });
    const events: E2eExploreEvent[] = [];
    const runner = new PlaywrightE2eRunner({ loadPlaywright, settleMs: 1 });

    const snapshot = await runner.explore({
      mode: 'frontend',
      url: `${ORIGIN}/`,
      credentials: account,
      onProgress: (event) => {
        events.push(event);
        // A listener that fails never stops the exploration.
        if (events.length === 1) throw new Error('listener failed');
      },
    });

    expect(snapshot.pages.map((item) => item.title)).toEqual([
      'Sign in',
      'Home',
      'About',
      'Issues',
    ]);
    expect(calls).toEqual([
      `goto:${ORIGIN}/`,
      'click:1',
      'type:qa@example.com',
      'click:3',
      'type:pw-secret',
      'press:Enter',
      `goto:${ORIGIN}/about`,
      // Back to the start before the navigation is clicked through.
      `goto:${ORIGIN}/`,
      'click:10',
      'click:-1',
      'click:30',
    ]);
    expect(
      events
        .filter((event) => event.kind === 'log')
        .map((event) => [event.action, event.target, event.result]),
    ).toEqual([
      ['navigate', `${ORIGIN}/`, 'Sign in'],
      ['sign_in', 'qa@example.com', 'Home'],
      ['navigate', `${ORIGIN}/about`, 'About'],
      ['click', 'Issues', 'Issues'],
      ['click', 'Broken', null],
      ['click', 'Docs', 'Home'],
    ]);
    expect(events.filter((event) => event.kind === 'phase').map((event) => event.phase)).toEqual([
      'signing_in',
      'exploring',
    ]);
    expect(events.filter((event) => event.kind === 'page')).toHaveLength(4);
    expect(events.some((event) => event.kind === 'frame')).toBe(true);
  });

  it('leaves the site it was sent away from and goes back to the start', async () => {
    const { calls, loadPlaywright } = fakeBrowser({
      snapshots: [snap('Home'), snap('Home')],
      targets: [target('Docs')],
      url: () => 'https://elsewhere.test/docs',
    });
    await new PlaywrightE2eRunner({ loadPlaywright, settleMs: 0 }).explore({
      mode: 'frontend',
      url: `${ORIGIN}/`,
    });
    // No link was followed, so the only extra navigation is the way back.
    expect(calls).toEqual([`goto:${ORIGIN}/`, 'click:10', `goto:${ORIGIN}/`]);
  });

  it('signs in without a username field and without frames or addresses to read', async () => {
    const { calls, loadPlaywright } = fakeBrowser({
      snapshots: [snap('Sign in'), new Error('navigating'), snap('Home')],
      form: { user: null, password: { x: 3, y: 4 } },
      screenshot: false,
      url: false,
      targets: [target('Only')],
    });
    const events: E2eExploreEvent[] = [];
    const snapshot = await new PlaywrightE2eRunner({ loadPlaywright, settleMs: 0 }).explore({
      mode: 'frontend',
      url: `${ORIGIN}/`,
      credentials: account,
      onProgress: (event) => events.push(event),
    });
    expect(calls).toEqual([
      `goto:${ORIGIN}/`,
      'click:3',
      'type:pw-secret',
      'press:Enter',
      'click:10',
    ]);
    expect(snapshot.pages.map((item) => item.title)).toEqual(['Sign in', 'Home']);
    expect(
      events.find((event) => event.kind === 'log' && event.action === 'sign_in'),
    ).toMatchObject({ result: null });
    expect(events.some((event) => event.kind === 'frame')).toBe(false);
    expect(
      events.filter((event) => event.kind === 'page').every((e) => e.screenshot === null),
    ).toBe(true);
    // The click landed nowhere readable: the log says so.
    expect(events.at(-1)).toMatchObject({ kind: 'log', action: 'click', result: null });
  });

  it.each([
    ['no username', { credentials: { username: null, password: 'x' } }, {}],
    ['no password', { credentials: { username: 'qa', password: null } }, {}],
    ['no keyboard', { credentials: account }, { keyboard: false as const }],
    ['no mouse', { credentials: account }, { mouse: false as const }],
    ['no sign-in form', { credentials: account }, { form: null }],
    ['an unreadable page', { credentials: account }, { form: new Error('detached') }],
  ])('stays signed out with %s', async (_name, input, fake) => {
    const { calls, loadPlaywright } = fakeBrowser({
      snapshots: [snap('Public')],
      form: { user: null, password: { x: 3, y: 4 } },
      ...fake,
    });
    const snapshot = await new PlaywrightE2eRunner({ loadPlaywright, settleMs: 0 }).explore({
      mode: 'frontend',
      url: `${ORIGIN}/`,
      ...input,
    });
    expect(snapshot.pages).toHaveLength(1);
    expect(calls).toEqual([`goto:${ORIGIN}/`]);
  });

  it.each([
    ['the step limit', { exploreSteps: 1 }, undefined, 1],
    ['the page limit', { explorePages: 1 }, undefined, 0],
    ['the time budget', { exploreBudgetMs: -1 }, undefined, 0],
    ['a cancelled run', {}, AbortSignal.abort(), 0],
  ])('stops clicking at %s', async (_name, limits, signal, clicks) => {
    const { page, loadPlaywright } = fakeBrowser({
      snapshots: [snap('Home'), snap('One'), snap('Two')],
      targets: [target('One'), target('Two')],
      screenshot: () => Promise.reject(new Error('no frame')),
    });
    await new PlaywrightE2eRunner({ loadPlaywright, settleMs: 0, ...limits }).explore({
      mode: 'frontend',
      url: `${ORIGIN}/`,
      signal,
    });
    expect(page.mouse!.click).toHaveBeenCalledTimes(clicks);
  });

  it('stops when the page can no longer be searched for targets', async () => {
    const { page, loadPlaywright } = fakeBrowser({
      snapshots: [snap('Home')],
      targets: [new Error('context destroyed')],
    });
    await new PlaywrightE2eRunner({ loadPlaywright, settleMs: 0 }).explore({
      mode: 'frontend',
      url: `${ORIGIN}/`,
    });
    expect(page.mouse!.click).not.toHaveBeenCalled();
  });

  it('names and tells screens apart by address, title and first headings', () => {
    expect(pageName(snap('Title', { headings: ['Heading'] }))).toBe('Heading');
    expect(pageName(snap('Title', { headings: [] }))).toBe('Title');
    expect(pageName(snap('', { headings: [] }))).toBe(`${ORIGIN}/`);
    expect(pageKey(snap('T', { url: `${ORIGIN}/a#top`, headings: ['A', 'B', 'C'] }))).toBe(
      `${ORIGIN}/a|T|A|B`,
    );
  });
});

describe('reading the trail and the live frame of a run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-trail-'));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  function evidence(name: string, lines: unknown[] | null): string {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { recursive: true });
    if (lines)
      fs.writeFileSync(
        path.join(directory, 'trail.jsonl'),
        lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n'),
      );
    return directory;
  }

  it('returns nothing without a trail or without pages', async () => {
    expect(await readTrail(evidence('missing', null), [])).toBeNull();
    expect(await readTrail(evidence('empty', [{ type: 'visit', index: 1 }]), [])).toBeNull();
  });

  it('keeps valid entries, their images and masks secrets', async () => {
    const directory = evidence('full', [
      {
        type: 'page',
        index: 1,
        url: 'http://app/a?token=abc',
        title: 'A',
        screenshot: 'trail-page-1.jpg',
      },
      { type: 'page', index: 2, url: 5, title: null, screenshot: '../secret.jpg' },
      { type: 'page', index: 3, url: 'http://app/c', title: 'C', screenshot: 'trail-page-3.jpg' },
      { type: 'page', index: 4, url: 'http://app/d', title: 'D', screenshot: 'trail-page-4.jpg' },
      { type: 'page', index: 0, url: 'http://app/ignored', title: 'no index' },
      'not json',
      'null',
      '',
      { type: 'visit', index: 1 },
      { type: 'visit', index: 'x' },
      {
        type: 'element',
        index: 1,
        pageIndex: 1,
        kind: 'button',
        name: 'Save hunter2 now',
        box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        screenshot: 'trail-element-1.jpg',
      },
      {
        type: 'element',
        index: 2,
        pageIndex: 1,
        kind: '',
        name: 7,
        box: { x: 2, y: 0, width: 1, height: 1 },
      },
      { type: 'element', index: 3 },
      {
        type: 'touch',
        atMs: 12,
        step: 1,
        action: 'type',
        pageIndex: 1,
        elementIndex: 1,
        value: 'hunter2',
      },
      {
        type: 'touch',
        atMs: 'late',
        step: -1,
        action: 'click',
        pageIndex: 1,
        elementIndex: 0,
        value: 9,
      },
      { type: 'touch', action: 'explode' },
      { type: 'other' },
    ]);
    fs.writeFileSync(path.join(directory, 'trail-page-1.jpg'), 'page');
    fs.writeFileSync(path.join(directory, 'trail-element-1.jpg'), 'element');
    // Larger than any screenshot the runner accepts.
    fs.writeFileSync(path.join(directory, 'trail-page-4.jpg'), Buffer.alloc(5_000_001));

    const trail = (await readTrail(directory, ['hunter2', null]))!;
    expect(trail.pages).toEqual([
      {
        index: 1,
        url: 'http://app/a?token=[redacted]',
        title: 'A',
        screenshot: Buffer.from('page'),
      },
      { index: 2, url: '', title: '', screenshot: null },
      { index: 3, url: 'http://app/c', title: 'C', screenshot: null },
      { index: 4, url: 'http://app/d', title: 'D', screenshot: null },
    ]);
    expect(trail.visits).toEqual([1]);
    expect(trail.elements).toEqual([
      {
        index: 1,
        pageIndex: 1,
        kind: 'button',
        name: 'Save [redacted] now',
        box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        screenshot: Buffer.from('element'),
      },
      { index: 2, pageIndex: 1, kind: 'element', name: '', box: null, screenshot: null },
      { index: 3, pageIndex: 0, kind: 'element', name: '', box: null, screenshot: null },
    ]);
    expect(trail.touches).toEqual([
      { atMs: 12, step: 1, action: 'type', pageIndex: 1, elementIndex: 1, value: '[redacted]' },
      { atMs: 0, step: 0, action: 'click', pageIndex: 1, elementIndex: null, value: null },
    ]);
  });

  it('hands each new live frame to the listener with the action in progress', async () => {
    const directory = evidence('live', null);
    const frames: E2eLiveFrame[] = [];
    const stop = watchLive(directory, 5, (frame) => frames.push(frame));
    try {
      // No frame yet: nothing is reported.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(frames).toEqual([]);

      fs.writeFileSync(path.join(directory, 'live.jpg'), 'frame-1');
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect(frames[0]).toEqual({ image: Buffer.from('frame-1'), activity: null });
      // The same frame is not reported twice.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(frames).toHaveLength(1);

      const next = (activity: unknown, mtime: number) => {
        fs.writeFileSync(path.join(directory, 'live.json'), JSON.stringify(activity));
        fs.writeFileSync(path.join(directory, 'live.jpg'), `frame-${mtime}`);
        fs.utimesSync(path.join(directory, 'live.jpg'), mtime, mtime);
      };
      next({ step: 2, action: 'click', kind: 'button', name: 'Save' }, 2_000_000_000);
      await vi.waitFor(() => expect(frames).toHaveLength(2));
      expect(frames[1]!.activity).toEqual({
        step: 2,
        action: 'click',
        kind: 'button',
        name: 'Save',
      });

      next({ step: 'x', action: 'type', kind: 3, name: null }, 2_000_000_100);
      await vi.waitFor(() => expect(frames).toHaveLength(3));
      expect(frames[2]!.activity).toEqual({ step: 0, action: 'type', kind: 'element', name: '' });

      next({ action: 'explode' }, 2_000_000_200);
      await vi.waitFor(() => expect(frames).toHaveLength(4));
      expect(frames[3]!.activity).toBeNull();
    } finally {
      stop();
    }
  });

  it('follows the live frame of a UI run and passes the custom variables to the spec', async () => {
    const frames: E2eLiveFrame[] = [];
    let environment: NodeJS.ProcessEnv = {};
    const executor: ProcessExecutor = async ({ cwd, env }) => {
      environment = env;
      fs.mkdirSync(path.join(cwd, 'evidence'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'evidence', 'live.jpg'), 'frame');
      fs.writeFileSync(
        path.join(cwd, 'evidence', 'trail.jsonl'),
        JSON.stringify({ type: 'page', index: 1, url: 'http://app/', title: 'Home' }),
      );
      fs.writeFileSync(
        path.join(cwd, 'report.json'),
        JSON.stringify({ suites: [{ specs: [{ tests: [{ results: [{ status: 'passed' }] }] }] }] }),
      );
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      return { exitCode: 0, stdout: 'token-value was printed', stderr: '', timedOut: false };
    };
    const runner = new PlaywrightE2eRunner({
      workspaceRoot: path.join(root, 'workspaces'),
      executor,
      liveIntervalMs: 5,
    });
    const result = await runner.run({
      script: "import { test } from '@playwright/test'; test('TC001', async () => {});",
      mode: 'frontend',
      baseUrl: 'http://app',
      locale: 'en-US',
      credentials: { username: null, password: null },
      variables: { API_KEY: 'token-value', 'bad-name': 'x' },
      onLive: (frame) => frames.push(frame),
    });
    expect(result.status).toBe('passed');
    expect(result.trail!.pages.map((page) => page.title)).toEqual(['Home']);
    expect(environment['E2E_VAR_API_KEY']).toBe('token-value');
    expect(Object.keys(environment).filter((key) => key.startsWith('E2E_VAR_'))).toEqual([
      'E2E_VAR_API_KEY',
    ]);
    // Variable values are secrets of the log.
    expect(result.logs).toBe('[redacted] was printed');
  });
});

describe('exploring with a focus (fake browser)', () => {
  const evaluated = (page: { evaluate: ReturnType<typeof vi.fn> }) =>
    page.evaluate.mock.calls
      .filter(([fn]) => fn === nextExploreTarget)
      .map(([, options]) => options as { keywords: string[]; detours: number });

  it('only follows the links that name the focus and limits the detours of the clicks', async () => {
    const { calls, page, loadPlaywright } = fakeBrowser({
      snapshots: [
        snap('Home', { links: [`${ORIGIN}/billing/invoices`, `${ORIGIN}/settings`] }),
        snap('Invoices'),
        snap('Billing'),
        snap('Help'),
        snap('About'),
        snap('More'),
      ],
      targets: [
        { ...target('Billing', 11), matched: true },
        { ...target('Help', 12), matched: false },
        { ...target('About', 13), matched: false },
        { ...target('More', 14), matched: false },
      ],
    });
    await new PlaywrightE2eRunner({ loadPlaywright, settleMs: 0 }).explore({
      mode: 'frontend',
      url: `${ORIGIN}/`,
      focus: 'The billing screens',
    });
    expect(calls).toContain(`goto:${ORIGIN}/billing/invoices`);
    expect(calls).not.toContain(`goto:${ORIGIN}/settings`);
    // A matching control keeps the detours; each one outside the focus uses one up.
    expect(evaluated(page).map((options) => options.detours)).toEqual([3, 3, 2, 1, 0]);
    expect(evaluated(page).every((options) => options.keywords.join() === 'billing')).toBe(true);
  });

  it('goes far beyond its usual limits when asked to map the whole application', async () => {
    const links = Array.from({ length: 12 }, (_, index) => `${ORIGIN}/page-${index}`);
    const explore = async (thorough: boolean) => {
      const { calls, loadPlaywright } = fakeBrowser({
        snapshots: [
          snap('Home', { links }),
          ...links.map((_, index) => snap(`Page ${index}`)),
          ...Array.from({ length: 8 }, (_, index) => snap(`Screen ${index}`)),
        ],
        targets: Array.from({ length: 8 }, (_, index) => target(`Menu ${index}`, index)),
      });
      // A runner configured to barely look around: two pages by links, two clicks.
      await new PlaywrightE2eRunner({
        loadPlaywright,
        settleMs: 0,
        maxPages: 3,
        exploreSteps: 2,
        explorePages: 5,
        exploreBudgetMs: 1_000,
      }).explore({ mode: 'frontend', url: `${ORIGIN}/`, thorough });
      return {
        links: calls.filter((call) => call.startsWith(`goto:${ORIGIN}/page-`)).length,
        clicks: calls.filter((call) => call.startsWith('click:')).length,
      };
    };
    expect(await explore(false)).toEqual({ links: 2, clicks: 2 });
    expect(await explore(true)).toEqual({ links: 12, clicks: 8 });
    expect(THOROUGH_EXPLORE_LIMITS).toMatchObject({ links: 40, steps: 150, pages: 60 });
  });

  it.each([undefined, '', 'the whole site', 'só o site inteiro'])(
    'stays open when the focus %j names nothing specific',
    async (focus) => {
      const { calls, page, loadPlaywright } = fakeBrowser({
        snapshots: [snap('Home', { links: [`${ORIGIN}/a`, `${ORIGIN}/b`] }), snap('A'), snap('B')],
        targets: [target('One')],
      });
      await new PlaywrightE2eRunner({ loadPlaywright, settleMs: 0 }).explore({
        mode: 'frontend',
        url: `${ORIGIN}/`,
        ...(focus === undefined ? {} : { focus }),
      });
      expect(calls).toContain(`goto:${ORIGIN}/a`);
      expect(calls).toContain(`goto:${ORIGIN}/b`);
      expect(evaluated(page)[0]).toMatchObject({ keywords: [] });
    },
  );

  it('takes the words of a description and matches them without accents or case', () => {
    expect(focusKeywords('  Só as telas de COBRANÇA e o filtro de faturas! ')).toEqual([
      'cobranca',
      'filtro',
      'faturas',
    ]);
    expect(focusKeywords('billing billing BILLING')).toEqual(['billing']);
    expect(focusKeywords(null)).toEqual([]);
    expect(focusKeywords('one two three four five six seven eight nine ten')).toHaveLength(8);
    expect(matchesFocus(['cobranca'], 'Cobrança', '/x')).toBe(true);
    expect(matchesFocus(['invoices'], 'Plans', '/billing/invoices')).toBe(true);
    expect(matchesFocus(['invoices'], 'Plans', '/billing')).toBe(false);
  });
});
