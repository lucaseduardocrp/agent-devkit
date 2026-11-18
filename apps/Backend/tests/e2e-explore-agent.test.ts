import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentE2eAuthor,
  fitContext,
  parseJsonObject,
  readExploreStep,
} from '../src/modules/e2e/application/e2e-author.js';
import {
  PlaywrightE2eRunner,
  clearExploreMark,
  collectPageSnapshot,
  findSignInForm,
  inspectSignIn,
  isRendered,
  isSettled,
  listNavAreas,
  moveExploreCursor,
  pressExploreCursor,
  listAgentElements,
  locateAgentElement,
  scrollAgentPage,
  selectAgentOption,
  nextExploreTarget,
  type PlaywrightModule,
} from '../src/modules/e2e/adapters/playwright-runner.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';
import type { LlmPort } from '../src/modules/agents/application/agent-ports.js';
import type { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';
import type { E2eCreation } from '../src/modules/e2e/domain/e2e.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import { E2eExecutor } from '../src/modules/e2e/application/e2e-executor.js';
import {
  ExplorationRecorder,
  readExploration,
} from '../src/modules/e2e/application/e2e-exploration.js';
import type { E2eJob } from '../src/modules/e2e/application/e2e-queue.js';
import { InMemoryE2eStore } from '../src/modules/e2e/application/e2e-store.js';
import type {
  E2eAgentAction,
  E2eAgentElement,
  E2eAgentObservation,
  E2eExploreAgent,
  E2eExploreEvent,
  E2ePageSnapshot,
} from '../src/modules/e2e/application/e2e-runner.js';

const ORIGIN = 'http://app.test';

// ---------------------------------------------------------------------------------------------
// The author turns what the model answers into the next step of the exploration.
// ---------------------------------------------------------------------------------------------

const creation = {
  id: 'c',
  workspaceId: 'ws',
  ownerId: 'owner',
  agentId: 'agent',
  locale: 'pt-BR',
} as E2eCreation;

const observation: E2eAgentObservation = {
  step: 1,
  maxSteps: 30,
  page: {
    url: `${ORIGIN}/`,
    title: 'Home',
    headings: ['Home'],
    buttons: [],
    links: [],
    fields: [],
    testIds: [],
  },
  text: 'Welcome',
  elements: [{ id: 1, role: 'button', label: 'Files' }],
  history: [],
  screens: ['Home'],
  plan: [],
};

function author(text: string | Error) {
  const complete = vi.fn((_request: { prompt: string; instruction?: string }) =>
    text instanceof Error ? Promise.reject(text) : Promise.resolve({ text, provider: 'fake' }),
  );
  const llm = { provider: 'fake', complete, stream: vi.fn() } as unknown as LlmPort;
  const executeAgent = vi.fn();
  const agents = {
    getAgent: vi.fn().mockResolvedValue({ instructions: 'You are QA.', model: 'm1', skills: [] }),
    // A workflow would run on every step; the exploration asks the model directly.
    getWorkflow: vi.fn().mockResolvedValue({ enabled: true, steps: [{}] }),
    executeAgent,
  } as unknown as AgentService;
  const providers = {
    resolveLlmProvider: vi.fn().mockResolvedValue(llm),
  } as unknown as DynamicProviderFactory;
  return { complete, executeAgent, subject: new AgentE2eAuthor({ agents, providers }) };
}

const step = (subject: AgentE2eAuthor) =>
  subject.exploreStep({
    creation,
    observation,
    tests: [{ code: 'TC1', title: 'Filter files', description: 'd', steps: ['open Files'] }],
    instructions: 'Explore the files page',
  });

describe('AgentE2eAuthor.exploreStep', () => {
  it('gives the model the tests, the screen and the history, and asks for a reason in the language', async () => {
    const { subject, complete, executeAgent } = author(
      '```json\n{"action":"click","element":1,"reason":"Abrir Arquivos"}\n```',
    );
    expect(await step(subject)).toEqual({ kind: 'click', element: 1, reason: 'Abrir Arquivos' });
    const request = complete.mock.calls[0]![0] as { prompt: string; instruction: string };
    expect(request.instruction).toContain('You are QA.');
    expect(request.instruction).toContain('Brazilian Portuguese');
    expect(request.prompt).toContain('Filter files');
    expect(request.prompt).toContain('Explore the files page');
    expect(request.prompt).toContain('"label": "Files"');
    // Page content is untrusted: it travels inside the sandbox envelope.
    expect(request.prompt).toContain('<untrusted_input');
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it.each([
    [
      '{"action":"type","element":2,"value":"report","submit":true,"reason":"r"}',
      {
        kind: 'type',
        element: 2,
        value: 'report',
        submit: true,
        reason: 'r',
      },
    ],
    [
      '{"action":"type","element":"2","value":"x","reason":"r"}',
      {
        kind: 'type',
        element: 2,
        value: 'x',
        reason: 'r',
      },
    ],
    ['{"action":"press","key":"Enter","reason":"r"}', { kind: 'press', key: 'Enter', reason: 'r' }],
    ['{"action":"goto","url":"/files","reason":"r"}', { kind: 'goto', url: '/files', reason: 'r' }],
    ['{"action":"finish"}', { kind: 'finish', reason: '' }],
  ])('reads %s', async (text, expected) => {
    expect(await step(author(text).subject)).toEqual(expected);
  });

  it.each([
    ['prose without JSON', 'I would click the button'],
    ['an unknown action', '{"action":"hover","element":1}'],
    ['a click without a control', '{"action":"click"}'],
    ['typing without a value', '{"action":"type","element":1}'],
    ['typing without a control', '{"action":"type","value":"x"}'],
    ['a key press without a key', '{"action":"press"}'],
    ['a goto without an address', '{"action":"goto"}'],
  ])('rejects %s', async (_name, text) => {
    await expect(step(author(text).subject)).rejects.toMatchObject({
      code: 'E2E_EXPLORE_ACTION_INVALID',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The runner drives the browser with the decisions of the agent.
// ---------------------------------------------------------------------------------------------

const snap = (title: string, url = `${ORIGIN}/`): E2ePageSnapshot => ({
  url,
  title,
  headings: [title],
  buttons: [],
  fields: [],
  testIds: [],
  links: [],
});

const el = (id: number, label: string, extra: Partial<E2eAgentElement> = {}): E2eAgentElement => ({
  id,
  role: 'button',
  label,
  ...extra,
});

interface FakeOptions {
  snapshots: (E2ePageSnapshot | Error)[];
  /** The controls of each screen the agent reads. */
  screens: (E2eAgentElement[] | Error)[];
  /** Where each click lands; null when the control is gone. */
  points?: ({ x: number; y: number } | null)[];
  form?: unknown;
  /** The form goes away once Enter is pressed (the account is accepted) and returns on each load. */
  signsIn?: boolean;
  /** A browser that cannot tell its address when null. */
  url?: (() => string) | null;
  clickFails?: boolean;
  /** The text of the choice a drop-down list takes; null when it has no such choice. */
  choice?: string | null;
  /** Menu items the site shows, dealt between the browsers of a parallel exploration. */
  areas?: string[];
  /** The browsers opened after the first one cannot start. */
  extraBrowsersFail?: boolean;
}

function fakeBrowser(options: FakeOptions) {
  const calls: string[] = [];
  const points = [...(options.points ?? [])];
  const screens = [...options.screens];
  let formShown = true;
  const page = {
    goto: vi.fn(async (target: string) => {
      calls.push(`goto:${target}`);
      formShown = true;
    }),
    waitForLoadState: vi.fn().mockRejectedValue(new Error('still loading')),
    evaluate: vi.fn(async (fn: unknown, arg?: { option?: string } | string) => {
      if (fn === collectPageSnapshot) {
        // The last screen stays on the browser once the script runs out.
        const next =
          options.snapshots.length > 1 ? options.snapshots.shift() : options.snapshots[0];
        if (next instanceof Error || !next) throw next ?? new Error('no page');
        return next;
      }
      if (fn === listAgentElements) {
        const next = screens.length > 1 ? screens.shift() : screens[0];
        if (next instanceof Error || !next) throw next ?? new Error('no screen');
        return { elements: next, text: 'text on screen' };
      }
      if (fn === locateAgentElement) return points.length ? points.shift() : { x: 7, y: 8 };
      if (fn === selectAgentOption) {
        calls.push(`select:${(arg as { option: string }).option}`);
        return options.choice === undefined ? 'Done' : options.choice;
      }
      if (fn === scrollAgentPage) {
        calls.push(`scroll:${arg as string}`);
        return undefined;
      }
      if (fn === findSignInForm)
        return !options.signsIn || formShown ? (options.form ?? null) : null;
      if (fn === listNavAreas) return options.areas ?? [];
      if (fn === inspectSignIn) return arg ? { focused: true, user: '', passwordLength: 0 } : null;
      if (fn === isRendered || fn === isSettled) return true;
      if (fn === nextExploreTarget) return null;
      if (fn === moveExploreCursor || fn === pressExploreCursor) return undefined;
      expect(fn).toBe(clearExploreMark);
      return undefined;
    }),
    screenshot: vi.fn(() => Promise.resolve(Buffer.from('jpeg'))),
    mouse: {
      click: vi.fn(async (x: number) => {
        calls.push(`click:${x}`);
        if (options.clickFails) throw new Error('page closed');
      }),
    },
    keyboard: {
      type: vi.fn(async (text: string) => {
        calls.push(`type:${text}`);
      }),
      press: vi.fn(async (key: string) => {
        calls.push(`press:${key}`);
        if (key === 'Enter') formShown = false;
      }),
    },
    ...(options.url === null ? {} : { url: vi.fn(options.url ?? (() => `${ORIGIN}/`)) }),
  };
  let opened = 0;
  /** What each browser was opened with. */
  const pageOptions: { recordVideo?: { dir: string; size: { width: number; height: number } } }[] =
    [];
  const loadPlaywright = () =>
    Promise.resolve({
      chromium: {
        launch: () =>
          Promise.resolve({
            newPage: (opening: (typeof pageOptions)[number]) => {
              opened += 1;
              pageOptions.push(opening);
              return options.extraBrowsersFail && opened > 1
                ? Promise.reject(new Error('no more browsers'))
                : Promise.resolve(page);
            },
            close: () => Promise.resolve(),
          }),
      },
    } as unknown as PlaywrightModule);
  return { page, calls, loadPlaywright, pageOptions };
}

/** An agent that answers each observation with the next action of a script. */
function scripted(actions: (E2eAgentAction | Error)[]) {
  const seen: E2eAgentObservation[] = [];
  const agent = vi.fn(async (view: E2eAgentObservation) => {
    seen.push(view);
    const next = actions.shift() ?? { kind: 'finish' as const, reason: 'nothing else' };
    if (next instanceof Error) throw next;
    return next;
  });
  return { agent, seen };
}

async function explore(
  fake: ReturnType<typeof fakeBrowser>,
  agent: ReturnType<typeof scripted>['agent'],
  extra: {
    thorough?: boolean;
    signal?: AbortSignal;
    credentials?: { username: string; password: string };
    tests?: { id: string; title: string; description: string; steps: string[] }[];
  } = {},
  options: ConstructorParameters<typeof PlaywrightE2eRunner>[0] = {},
) {
  const events: E2eExploreEvent[] = [];
  const snapshot = await new PlaywrightE2eRunner({
    loadPlaywright: fake.loadPlaywright,
    settleMs: 0,
    glideMs: 0,
    renderWaitMs: 1,
    ...options,
  }).explore({
    mode: 'frontend',
    url: `${ORIGIN}/`,
    agent,
    onProgress: (event) => events.push(event),
    ...extra,
  });
  const log = events.flatMap((event) => (event.kind === 'log' ? [event] : []));
  return { snapshot, events, log };
}

describe('exploring with the AI agent', () => {
  it('shares the navigation between several browsers, each with its own assignment', async () => {
    const fake = fakeBrowser({
      snapshots: [snap('Home')],
      screens: [[el(1, 'Files'), el(2, 'Reports'), el(3, 'People')]],
      areas: ['Files', 'Reports', 'People', 'Admin'],
    });
    const { agent, seen } = scripted([]);
    const { log } = await explore(fake, agent, {}, { explorers: 3 });
    const assignments = seen.map((view) => view.assignment!);
    expect(new Set(assignments.map((item) => item.worker))).toEqual(new Set([1, 2, 3]));
    expect(assignments.every((item) => item.workers === 3)).toBe(true);
    // Areas are dealt in turn.
    expect(assignments.find((item) => item.worker === 1)!.areas).toEqual(['Files', 'Admin']);
    expect(assignments.find((item) => item.worker === 2)!.areas).toEqual(['Reports']);
    // Only the first browser tells how the exploration ended.
    expect(log.filter((entry) => entry.action === 'note')).toHaveLength(1);
    // Each browser has its share of the steps (a little over a third of 60).
    expect(seen.every((view) => view.maxSteps === 30)).toBe(true);
  });

  it('tells each browser what the others plan and where they are', async () => {
    const fake = fakeBrowser({
      snapshots: [snap('Home'), snap('Files'), snap('Reports')],
      screens: [[el(1, 'Files'), el(2, 'Reports')]],
      areas: ['Files', 'Reports'],
    });
    const { agent, seen } = scripted([
      {
        kind: 'click',
        element: 1,
        reason: 'open',
        plan: [{ flow: 'Filter files by type', status: 'pending' }],
      },
    ]);
    await explore(fake, agent, {}, { explorers: 2 });
    const shares = seen[0]!.assignment!.shares;
    expect(shares).toEqual([['Files'], ['Reports']]);
    // A browser never sees itself among the others, whoever starts first.
    expect(
      seen.every((view) => view.others!.every((peer) => peer.worker !== view.assignment!.worker)),
    ).toBe(true);
    // Once a browser plans, the other one sees its flows.
    const later = seen.flatMap((view) => view.others!);
    expect(later.some((peer) => peer.flows.includes('Filter files by type'))).toBe(true);
    expect(later.every((peer) => typeof peer.screen === 'string' && peer.worker > 0)).toBe(true);
  });

  it('hands every action over with the screen it led to, its address and the browser that did it', async () => {
    const alone = fakeBrowser({
      snapshots: [snap('Home'), snap('Files')],
      screens: [[el(1, 'Files')]],
    });
    const { agent } = scripted([{ kind: 'click', element: 1, reason: 'open' }]);
    const single = await explore(alone, agent);
    const click = single.log.find((entry) => entry.action === 'click')!;
    expect(Buffer.from(click.screenshot!).toString()).toBe('jpeg');
    expect(click.url).toBe(`${ORIGIN}/`);
    // One browser needs no number.
    expect(click).not.toHaveProperty('worker');

    const shared = fakeBrowser({
      snapshots: [snap('Home'), snap('Files')],
      screens: [[el(1, 'Files')]],
      areas: ['Files', 'Reports'],
    });
    const parallel = await explore(
      shared,
      scripted([{ kind: 'click', element: 1, reason: 'x' }]).agent,
      {},
      { explorers: 2 },
    );
    expect(parallel.log.find((entry) => entry.action === 'click')!.worker).toBeGreaterThan(0);
  });

  it('explores alone when the site shows too little navigation to share', async () => {
    const fake = fakeBrowser({
      snapshots: [snap('Home')],
      screens: [[el(1, 'Files')]],
      areas: ['Files'],
    });
    const { agent, seen } = scripted([]);
    await explore(fake, agent, {}, { explorers: 3 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.assignment).toBeUndefined();
    expect(seen[0]!.maxSteps).toBe(60);
  });

  it('lets the browsers that started do the work of one that could not', async () => {
    const fake = fakeBrowser({
      snapshots: [snap('Home')],
      screens: [[el(1, 'Files')]],
      areas: ['Files', 'Reports'],
      extraBrowsersFail: true,
    });
    const { agent, seen } = scripted([]);
    const { snapshot } = await explore(fake, agent, {}, { explorers: 2 });
    // The first browser did its own area and then the one of the browser that never opened.
    expect(new Set(seen.map((view) => view.assignment!.worker))).toEqual(new Set([1]));
    expect(seen.flatMap((view) => view.assignment!.areas)).toEqual(['Files', 'Reports']);
    expect(seen.map((view) => view.assignment!.round)).toEqual([1, 2]);
    expect(snapshot.pages).toHaveLength(1);
  });

  it('gives each browser the tests of its piece of work, and another piece when it is done', async () => {
    const fake = fakeBrowser({
      snapshots: [snap('Home')],
      screens: [[el(1, 'Files')]],
      areas: ['Arquivos', 'Relatórios', 'Pessoas', 'Ajustes'],
    });
    const tests = [
      { id: 'TC1', title: 'Baixar arquivos', description: '', steps: [] },
      { id: 'TC2', title: 'Gerar relatórios', description: '', steps: [] },
      { id: 'TC3', title: 'Cadastrar pessoas', description: '', steps: [] },
      { id: 'TC4', title: 'Sem assunto', description: '', steps: [] },
    ];
    const { agent, seen } = scripted([]);
    await explore(fake, agent, { tests }, { explorers: 2 });
    const pieces = seen.map((view) => view.assignment!);
    // The tests and the areas were taken once each, however many pieces that took.
    expect(pieces.flatMap((piece) => piece.tests).sort()).toEqual(['TC1', 'TC2', 'TC3', 'TC4']);
    expect(pieces.flatMap((piece) => piece.areas).sort()).toEqual([
      'Ajustes',
      'Arquivos',
      'Pessoas',
      'Relatórios',
    ]);
    // Several pieces per browser: each finished its piece and was given another.
    expect(Math.max(...pieces.map((piece) => piece.round))).toBeGreaterThan(1);
    // A test goes with the area it talks about.
    const withFiles = pieces.find((piece) => piece.areas.includes('Arquivos'));
    expect(withFiles!.tests).toContain('TC1');
  });

  it('tells how the exploration ended once, with what every browser did', async () => {
    const fake = fakeBrowser({
      snapshots: [snap('Home'), snap('Files')],
      screens: [[el(1, 'Files'), el(2, 'Reports')]],
      areas: ['Files', 'Reports'],
    });
    const { agent } = scripted([
      { kind: 'click', element: 1, reason: 'open' },
      { kind: 'click', element: 2, reason: 'open' },
    ]);
    const { log } = await explore(fake, agent, {}, { explorers: 2 });
    const notes = log.filter((entry) => entry.action === 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.target).toBe('agent_done:2');
  });

  it('stops every browser when the steps of the exploration are used up', async () => {
    const fake = fakeBrowser({
      snapshots: [snap('Home')],
      screens: [[el(1, 'Files')]],
      areas: ['A', 'B', 'C', 'D'],
    });
    const { agent, seen } = scripted(
      Array.from({ length: 100 }, () => ({
        kind: 'scroll' as const,
        direction: 'down' as const,
        reason: 'look',
      })),
    );
    const { log } = await explore(fake, agent, {}, { explorers: 2, agentSteps: 4 });
    // 4 steps, shared, with half as many again: 6 decisions in all.
    expect(seen).toHaveLength(6);
    expect(log.filter((entry) => entry.action === 'note').map((entry) => entry.target)).toEqual([
      expect.stringMatching(/^stopped_steps:/),
    ]);
  });

  it('signs the extra browsers in without repeating the sign-in in the log', async () => {
    const fake = fakeBrowser({
      snapshots: [snap('Sign in'), snap('Home')],
      screens: [[el(1, 'Files')]],
      form: { user: { x: 1, y: 2 }, password: { x: 3, y: 4 } },
      signsIn: true,
      areas: ['Files', 'Reports'],
    });
    const { agent } = scripted([]);
    const { events, log } = await explore(
      fake,
      agent,
      { credentials: { username: 'qa', password: 'pw' } },
      { explorers: 2 },
    );
    // Each browser typed the account; the log tells one sign-in and the phase moves forward once.
    expect(fake.calls.filter((call) => call === 'type:pw')).toHaveLength(2);
    expect(log.filter((entry) => entry.action === 'sign_in')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'phase').map((event) => event.phase)).toEqual([
      'signing_in',
      'exploring',
    ]);
  });

  it('retries the sign-in of an extra browser and leaves its work to the others when it fails', async () => {
    const fake = fakeBrowser({
      snapshots: [snap('Sign in'), snap('Home')],
      screens: [[el(1, 'Files')]],
      // The form never goes away: the account is not accepted.
      form: { user: { x: 1, y: 2 }, password: { x: 3, y: 4 } },
      areas: ['Files', 'Reports'],
    });
    const { agent, seen } = scripted([]);
    await explore(
      fake,
      agent,
      { credentials: { username: 'qa', password: 'pw' } },
      { explorers: 2 },
    );
    // The first browser signed in once; the second tried three times and gave up.
    expect(fake.calls.filter((call) => call === 'type:pw')).toHaveLength(4);
    // Only the first browser explored, and it took the work of both.
    expect(new Set(seen.map((view) => view.assignment?.worker))).toEqual(new Set([1]));
  });

  it('fails when the first browser breaks, whatever the others did', async () => {
    const fake = fakeBrowser({
      snapshots: [snap('Home')],
      screens: [[el(1, 'Files')]],
      areas: ['Files', 'Reports'],
      url: () => {
        throw new Error('page crashed');
      },
    });
    const { agent } = scripted([{ kind: 'click', element: 1, reason: 'open' }]);
    await expect(explore(fake, agent, {}, { explorers: 2 })).rejects.toThrow('page crashed');
  });

  it('never uses more than six browsers', async () => {
    const fake = fakeBrowser({
      snapshots: [snap('Home')],
      screens: [[el(1, 'Files')]],
      areas: Array.from({ length: 20 }, (_, index) => `Area ${index}`),
    });
    const { agent, seen } = scripted([]);
    await explore(fake, agent, {}, { explorers: 99 });
    expect(new Set(seen.map((view) => view.assignment!.workers))).toEqual(new Set([6]));
  });

  it('browses like a person: clicks, types, presses keys and opens pages, saying why', async () => {
    const fake = fakeBrowser({
      snapshots: [
        snap('Home'),
        snap('Home'),
        snap('Files'),
        snap('Files'),
        snap('Files'),
        snap('Files'),
        snap('Files'),
        snap('Report', `${ORIGIN}/report`),
      ],
      screens: [
        [el(1, 'Files'), el(2, 'Search', { role: 'input', type: 'text' })],
        [el(1, 'Search', { role: 'input', type: 'text' })],
        [el(1, 'Search', { role: 'input', type: 'text' })],
        [el(1, 'Search', { role: 'input', type: 'text' })],
        [el(1, 'Search', { role: 'input', type: 'text' })],
      ],
      // Each control is found twice: when the cursor is sent and again before the click.
      points: [
        { x: 11, y: 1 },
        { x: 11, y: 1 },
        { x: 22, y: 2 },
        { x: 22, y: 2 },
      ],
    });
    const { agent, seen } = scripted([
      { kind: 'click', element: 1, reason: 'Open the files area' },
      { kind: 'type', element: 1, value: 'annual report', submit: true, reason: 'Filter by name' },
      { kind: 'press', key: 'Escape', reason: 'Close the suggestions' },
      { kind: 'goto', url: '/report', reason: 'Open the report page' },
      { kind: 'finish', reason: 'The tests are covered' },
    ]);

    const { snapshot, log } = await explore(fake, agent);

    expect(fake.calls).toEqual([
      `goto:${ORIGIN}/`,
      'click:11',
      'click:22',
      'press:Control+A',
      'type:annual report',
      'press:Enter',
      'press:Escape',
      `goto:${ORIGIN}/report`,
    ]);
    // Every step shows on the evidence like a person: a captioned cursor, pressing on clicks.
    const moves = fake.page.evaluate.mock.calls
      .filter(([fn]) => fn === moveExploreCursor)
      .map(([, arg]) => arg as { x: number | null; label: string; restore?: boolean });
    expect(moves.filter((move) => !move.restore).map((move) => move.label)).toEqual([
      '#1 Click "Files"',
      '#2 Type in "Search"',
      '#3 Press Escape',
      `#4 Open ${ORIGIN}/report`,
    ]);
    expect(moves.filter((move) => !move.restore).map((move) => move.x)).toEqual([11, 22, 22, 22]);
    expect(fake.page.evaluate.mock.calls.filter(([fn]) => fn === pressExploreCursor)).toHaveLength(
      2,
    );
    expect(log.map((entry) => [entry.action, entry.target, entry.result, entry.reason])).toEqual([
      ['navigate', `${ORIGIN}/`, 'Home', undefined],
      ['click', 'Files', 'Files', 'Open the files area'],
      ['type', 'Search = annual report', 'Files', 'Filter by name'],
      ['press', 'Escape', 'Files', 'Close the suggestions'],
      ['navigate', `${ORIGIN}/report`, 'Report', 'Open the report page'],
      ['note', 'agent_done:4', null, 'The tests are covered'],
    ]);
    expect(snapshot.pages.map((item) => item.title)).toEqual(['Home', 'Files', 'Report']);
    // The agent is told what it did, in order, and which screens it has reached.
    expect(seen[0]).toMatchObject({
      step: 1,
      maxSteps: 60,
      text: 'text on screen',
      history: [],
      plan: [],
    });
    expect(seen[2]!.history).toEqual([
      '1. click "Files" -> Files',
      '2. type "Search = annual report" -> Files',
    ]);
    expect(seen[2]!.screens).toEqual(['Home', 'Files']);
  });

  it('refuses what an exploration must never do, and tells the agent', async () => {
    const fake = fakeBrowser({
      snapshots: [
        snap('Home'),
        snap('Home'),
        snap('Home'),
        snap('Home'),
        snap('Home'),
        snap('Home'),
      ],
      screens: [[el(1, 'Sair'), el(2, 'Password', { role: 'input', type: 'password' })]],
    });
    const { agent, seen } = scripted([
      { kind: 'click', element: 1, reason: 'sign out' },
      { kind: 'type', element: 2, value: 'secret', reason: 'type the password' },
      { kind: 'click', element: 9, reason: 'a control that is not there' },
      { kind: 'press', key: 'F12', reason: 'devtools' },
      { kind: 'goto', url: 'https://elsewhere.test/', reason: 'leave' },
      { kind: 'goto', url: 'http://[bad', reason: 'broken address' },
    ]);
    const { log } = await explore(fake, agent);
    // Nothing was done in the browser besides opening the site.
    expect(fake.calls).toEqual([`goto:${ORIGIN}/`]);
    expect(seen.at(-1)!.history).toEqual([
      '1. click: not done ("Sair" signs out or deletes, which an exploration never does)',
      '2. type: not done (passwords are typed by the sign-in only)',
      '3. click: not done (there is no control #9)',
      '4. press: not done (the key F12 is not allowed)',
      '5. goto: not done (it leaves the site)',
      '6. goto: not done (it is not an address)',
    ]);
    expect(log.some((entry) => entry.action === 'click')).toBe(false);
  });

  it('skips a step whose control is gone or whose click breaks, and goes on', async () => {
    const gone = fakeBrowser({
      snapshots: [snap('Home'), snap('Home')],
      screens: [[el(1, 'Files')], [el(1, 'Files')]],
      points: [null],
    });
    const goneAgent = scripted([{ kind: 'click', element: 1, reason: 'open' }]);
    const first = await explore(gone, goneAgent.agent);
    expect(goneAgent.seen[1]!.history).toEqual(['1. click: not done (the control is gone)']);
    expect(first.log.at(-1)).toMatchObject({ action: 'note', target: 'agent_done:0' });

    const broken = fakeBrowser({
      snapshots: [snap('Home'), snap('Home')],
      screens: [[el(1, 'Files')], [el(1, 'Files')]],
      clickFails: true,
    });
    const brokenAgent = scripted([{ kind: 'click', element: 1, reason: 'open' }]);
    await explore(broken, brokenAgent.agent);
    expect(brokenAgent.seen[1]!.history).toEqual(['1. click: failed (page closed)']);
  });

  it('follows a control that moved while the cursor glided, so the click lands on it', async () => {
    const fake = fakeBrowser({
      snapshots: [snap('Home'), snap('Home')],
      screens: [[el(1, 'Painel')], [el(1, 'Painel')]],
      // The layout shifted down while the page was loading: the click goes where the control is now.
      points: [
        { x: 30, y: 277 },
        { x: 31, y: 309 },
        { x: 31, y: 309 },
      ],
    });
    await explore(fake, scripted([{ kind: 'click', element: 1, reason: 'open Painel' }]).agent);
    expect(fake.calls).toContain('click:31');
    const moves = fake.page.evaluate.mock.calls
      .filter(([fn]) => fn === moveExploreCursor)
      .map(([, arg]) => arg as { x: number | null; y: number | null; restore?: boolean })
      .filter((move) => !move.restore);
    expect(moves.map((move) => move.y)).toEqual([277, 309]);
  });

  it('goes back to the site when an action leaves it', async () => {
    const fake = fakeBrowser({
      snapshots: [snap('Home'), snap('Home'), snap('Home')],
      screens: [[el(1, 'Docs')], [el(1, 'Docs')]],
      url: () => (fake.calls.at(-1) === 'click:7' ? 'https://elsewhere.test/docs' : `${ORIGIN}/`),
    });
    await explore(fake, scripted([{ kind: 'click', element: 1, reason: 'open docs' }]).agent);
    expect(fake.calls).toEqual([`goto:${ORIGIN}/`, 'click:7', `goto:${ORIGIN}/`]);
  });

  it('stops when the agent repeats itself', async () => {
    const fake = fakeBrowser({
      snapshots: Array.from({ length: 8 }, () => snap('Home')),
      screens: Array.from({ length: 8 }, () => [el(1, 'Files')]),
    });
    const { agent } = scripted(
      Array.from({ length: 5 }, () => ({ kind: 'click' as const, element: 1, reason: 'again' })),
    );
    const { log } = await explore(fake, agent);
    // It did the action once; the same one again was sent back, and a third time ended it.
    expect(log.at(-1)).toMatchObject({ action: 'note', target: 'agent_stuck:1' });
    expect(log.filter((entry) => entry.action === 'click')).toHaveLength(1);
  });

  it('stops at its limits: steps, pages, time and a cancelled run', async () => {
    const run = async (
      options: ConstructorParameters<typeof PlaywrightE2eRunner>[0],
      signal?: AbortSignal,
    ) => {
      const fake = fakeBrowser({
        snapshots: Array.from({ length: 10 }, (_, index) => snap(`Page ${index}`)),
        screens: Array.from({ length: 10 }, (_, index) => [el(1, `Go ${index}`)]),
      });
      const actions = Array.from({ length: 10 }, (_, index) => ({
        kind: 'click' as const,
        element: 1,
        reason: `step ${index}`,
      }));
      const { agent } = scripted(actions);
      const { log } = await explore(fake, agent, { signal }, options);
      return log.at(-1);
    };
    expect(await run({ agentSteps: 2 })).toMatchObject({ target: 'stopped_steps:2' });
    expect(await run({ agentBudgetMs: -1 })).toMatchObject({ target: 'stopped_time:0' });
    expect((await run({}, AbortSignal.abort()))?.action).toBe('navigate');
  });

  it('stops when it has reached as many pages as an exploration may capture', async () => {
    const fake = fakeBrowser({
      snapshots: Array.from({ length: 120 }, (_, index) => snap(`Page ${index}`)),
      screens: Array.from({ length: 60 }, (_, index) => [el(1, `Go ${index}`)]),
    });
    const { agent } = scripted(
      Array.from({ length: 60 }, (_, index) => ({
        kind: 'click' as const,
        element: 1,
        reason: `step ${index}`,
      })),
    );
    const { log, snapshot } = await explore(fake, agent, {}, { agentSteps: 100, explorePages: 5 });
    // Walking through flows reaches far more screens than a crawl: the cap is 40, not 5.
    expect(snapshot.pages).toHaveLength(40);
    expect(log.at(-1)).toMatchObject({ target: 'stopped_pages:39' });
  });

  it('explores the whole application with far more steps when asked to be thorough', async () => {
    const fake = fakeBrowser({
      snapshots: Array.from({ length: 170 }, (_, index) => snap(`Page ${index}`)),
      screens: Array.from({ length: 170 }, (_, index) => [el(1, `Go ${index}`)]),
    });
    const { agent } = scripted(
      Array.from({ length: 170 }, (_, index) => ({
        kind: 'click' as const,
        element: 1,
        reason: `step ${index}`,
      })),
    );
    const { log } = await explore(
      fake,
      agent,
      { thorough: true },
      { explorePages: 200, agentSteps: 3 },
    );
    expect(log.at(-1)).toMatchObject({ target: 'stopped_steps:150' });
  });

  it('falls back to clicking through the navigation when the agent fails, saying so', async () => {
    const fake = fakeBrowser({
      snapshots: [snap('Home'), snap('Home')],
      screens: [[el(1, 'Files')]],
    });
    // The model is asked again after a failure; it is given up only after several in a row.
    const failure = new Error('No LLM provider available.\nsecond line');
    const { agent } = scripted([failure, failure, failure]);
    const { log, snapshot } = await explore(fake, agent);
    expect(log.find((entry) => entry.action === 'note')).toMatchObject({
      target: 'agent_failed:0',
      reason: 'No LLM provider available.',
    });
    expect(snapshot.pages).toHaveLength(1);
    // The way back to the start before the navigation is clicked through.
    expect(fake.calls).toEqual([`goto:${ORIGIN}/`, `goto:${ORIGIN}/`]);
  });

  it('falls back when the page cannot be read, and ignores a failure caused by a cancelled run', async () => {
    const unreadable = fakeBrowser({ snapshots: [snap('Home')], screens: [new Error('detached')] });
    const first = await explore(unreadable, scripted([]).agent);
    expect(first.log.find((entry) => entry.action === 'note')).toMatchObject({
      target: 'agent_failed:0',
      reason: 'The page could not be read.',
    });

    const controller = new AbortController();
    const cancelled = fakeBrowser({
      snapshots: [snap('Home'), snap('Home')],
      screens: [[el(1, 'Files')]],
    });
    const agent = vi.fn(() => {
      controller.abort();
      return Promise.reject(new Error('aborted'));
    });
    const second = await explore(cancelled, agent, { signal: controller.signal });
    expect(second.log.some((entry) => entry.target.startsWith('agent_failed'))).toBe(false);
  });

  it('is not used by a browser that cannot type, and stays out of API explorations', async () => {
    const fake = fakeBrowser({ snapshots: [snap('Home')], screens: [] });
    Object.assign(fake.page, { keyboard: undefined });
    const { agent } = scripted([]);
    await explore(fake, agent);
    expect(agent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// The executor gives the runner an agent built from the tests of the run.
// ---------------------------------------------------------------------------------------------

describe('E2eExecutor exploration agent', () => {
  async function worker(author: object, executionTarget: 'remote' | 'local' = 'remote') {
    const store = new InMemoryE2eStore();
    const artifacts = new InMemoryE2eArtifactStore();
    const anchor = await store.createCreation({
      workspaceId: 'ws',
      ownerId: 'owner',
      actorId: 'user',
      agentId: 'agent',
      name: 'Run',
      mode: 'frontend',
      scope: 'codebase',
      baseUrl: 'http://app',
      executionTarget,
      localOrigin: null,
      path: '/',
      username: null,
      passwordSecret: null,
      accessSecret: null,
      prd: '',
      prdFileNames: [],
      diff: null,
      instructions: 'Check the files filter',
      locale: 'en-US',
      repository: null,
      status: 'draft',
      useBrain: false,
      internal: false,
    });
    await store.replaceTests(anchor, [
      { title: 'Filter files', description: 'By name', priority: 'high', steps: ['open Files'] },
    ]);
    const runner = {
      explore: vi.fn().mockResolvedValue({ startUrl: 'http://app/', pages: [] }),
    };
    const localRunner = { for: vi.fn(() => runner) };
    const executor = new E2eExecutor({
      store,
      artifacts,
      runner,
      localRunner,
      author,
    } as never);
    const job = { workspaceId: 'ws', creationId: anchor.id, kind: 'explore' } as E2eJob;
    return { store, artifacts, anchor, executor, runner, job };
  }
  const finish: E2eAgentAction = { kind: 'finish', reason: 'done' };

  it('asks the author for each step with the tests of the run and what the user asked', async () => {
    const exploreStep = vi.fn().mockResolvedValue(finish);
    const { artifacts, anchor, executor, runner, job } = await worker({ exploreStep });
    await ExplorationRecorder.start(artifacts, anchor, false, Date.now, {
      description: 'Only the files page',
    });
    await executor.run(job, new AbortController().signal);

    const { agent } = runner.explore.mock.calls[0]![0] as { agent: E2eExploreAgent };
    expect(await agent(observation)).toEqual(finish);
    expect(exploreStep).toHaveBeenCalledWith(
      expect.objectContaining({
        observation,
        instructions: 'Only the files page',
        tests: [expect.objectContaining({ title: 'Filter files', steps: ['open Files'] })],
      }),
    );
    // A cancelled step is told to stop through the signal the runner passes.
    const controller = new AbortController();
    await agent(observation, controller.signal);
    expect(exploreStep.mock.calls[1]![0].signal).toBe(controller.signal);
  });

  it('uses the instructions of the run when the exploration has none, and no tests for the Source', async () => {
    const exploreStep = vi.fn().mockResolvedValue(finish);
    const { artifacts, anchor, executor, runner, job } = await worker({ exploreStep });
    await ExplorationRecorder.start(artifacts, anchor, false, Date.now, {});
    await executor.run(job, new AbortController().signal);
    const first = runner.explore.mock.calls[0]![0] as { agent: E2eExploreAgent };
    await first.agent(observation);
    expect(exploreStep.mock.calls[0]![0]).toMatchObject({ instructions: 'Check the files filter' });

    await ExplorationRecorder.start(artifacts, anchor, false, Date.now, { source: true });
    await executor.run(job, new AbortController().signal);
    const whole = runner.explore.mock.calls[1]![0] as { agent: E2eExploreAgent };
    await whole.agent(observation);
    expect(exploreStep.mock.calls[1]![0]).toMatchObject({ tests: [] });
  });

  it('explores by itself when the author cannot decide steps', async () => {
    const { artifacts, anchor, executor, runner, job } = await worker({});
    await ExplorationRecorder.start(artifacts, anchor, false, Date.now, {});
    await executor.run(job, new AbortController().signal);
    expect(runner.explore.mock.calls[0]![0]).not.toHaveProperty('agent');
  });

  it('says in the log that the agent cannot drive the browser of another computer', async () => {
    const exploreStep = vi.fn();
    const { artifacts, anchor, executor, runner, job } = await worker({ exploreStep }, 'local');
    await ExplorationRecorder.start(artifacts, anchor, false, Date.now, {});
    await executor.run(job, new AbortController().signal);
    expect(runner.explore.mock.calls[0]![0]).not.toHaveProperty('agent');
    const state = await readExploration(artifacts, anchor);
    expect(state?.log).toEqual([
      expect.objectContaining({ action: 'note', target: 'agent_unavailable', result: null }),
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Walking through every flow: the plan, choices in lists, scrolling and a model that errs.
// ---------------------------------------------------------------------------------------------

describe('exploring every flow of the tests', () => {
  const home = () => ({
    snapshots: Array.from({ length: 30 }, () => snap('Home')),
    screens: Array.from({ length: 30 }, (_, index) => [
      el(1, 'Files'),
      el(2, 'Type', { role: 'select', options: ['All', 'Reports'] }),
      el(3, `Item ${index}`),
    ]),
  });
  const plan = (...items: [string, 'pending' | 'done' | 'blocked'][]) =>
    items.map(([flow, status]) => ({ flow, status }));

  it('plans the flows first, tells the log, and keeps the agent informed of its plan', async () => {
    const fake = fakeBrowser(home());
    const { agent, seen } = scripted([
      {
        kind: 'click',
        element: 1,
        reason: 'open',
        plan: plan(['Open files', 'pending'], ['Filter by type', 'pending']),
      },
      {
        kind: 'select',
        element: 2,
        option: 'Reports',
        reason: 'filter',
        plan: plan(['Open files', 'done'], ['Filter by type', 'pending']),
      },
      {
        kind: 'finish',
        reason: 'all done',
        plan: plan(['Open files', 'done'], ['Filter by type', 'done']),
      },
    ]);
    const { log } = await explore(fake, agent);
    expect(log.map((entry) => [entry.action, entry.target])).toEqual([
      ['navigate', `${ORIGIN}/`],
      ['note', 'agent_plan:2'],
      ['click', 'Files'],
      ['select', 'Type = Done'],
      ['note', 'agent_done:2'],
    ]);
    expect(log[1]!.reason).toBe('Open files · Filter by type');
    expect(seen[0]!.plan).toEqual([]);
    expect(seen[1]!.plan).toEqual(plan(['Open files', 'pending'], ['Filter by type', 'pending']));
    expect(seen[2]!.plan[0]!.status).toBe('done');
    expect(fake.calls).toContain('select:Reports');
  });

  it('saves the screen as the evidence of each flow the agent marks done, named after the flow', async () => {
    const fake = fakeBrowser({
      snapshots: Array.from({ length: 30 }, () => ({ ...snap('Home'), dialog: 'Legend' })),
      screens: Array.from({ length: 30 }, () => [el(1, 'Files')]),
    });
    const { agent } = scripted([
      {
        kind: 'click',
        element: 1,
        reason: 'open',
        plan: plan(['Open legend', 'pending'], ['Export', 'blocked']),
      },
      {
        kind: 'click',
        element: 1,
        reason: 'again',
        plan: plan(['Open legend', 'done'], ['Export', 'blocked']),
      },
      // A plan that says the same again, or marks other flows, does not save the flow twice.
      { kind: 'finish', reason: 'done', plan: plan(['Open legend', 'done'], ['Export', 'done']) },
    ]);
    const { events } = await explore(fake, agent);
    const flows = events.flatMap((event) =>
      event.kind === 'page' && event.flow
        ? [[event.flow, event.page.dialog, Boolean(event.screenshot)]]
        : [],
    );
    expect(flows).toEqual([
      ['Open legend', 'Legend', true],
      ['Export', 'Legend', true],
    ]);
  });

  it('sends the agent back to work while flows of its plan are pending, a few times', async () => {
    const fake = fakeBrowser(home());
    const pending = plan(['Filter by type', 'pending']);
    const { agent, seen } = scripted([
      { kind: 'finish', reason: 'enough', plan: pending },
      { kind: 'finish', reason: 'enough' },
      { kind: 'finish', reason: 'enough' },
      { kind: 'finish', reason: 'really enough' },
    ]);
    const { log } = await explore(fake, agent);
    expect(seen.at(-1)!.history).toEqual([
      expect.stringContaining('finish: not done (flows of your plan still pending: Filter by type'),
      expect.stringContaining('finish: not done'),
      expect.stringContaining('finish: not done'),
    ]);
    // After three reminders it is allowed to stop, with its own reason.
    expect(log.at(-1)).toMatchObject({ target: 'agent_done:0', reason: 'really enough' });
  });

  it('lets the agent finish when its flows are done or blocked', async () => {
    const fake = fakeBrowser(home());
    const { agent, seen } = scripted([
      {
        kind: 'finish',
        reason: 'one is blocked',
        plan: plan(['Open files', 'done'], ['Download', 'blocked']),
      },
    ]);
    const { log } = await explore(fake, agent);
    expect(seen).toHaveLength(1);
    expect(log.at(-1)).toMatchObject({ target: 'agent_done:0', reason: 'one is blocked' });
  });

  it('asks the model again after a failed answer, and tells the agent what went wrong', async () => {
    const fake = fakeBrowser(home());
    const { agent, seen } = scripted([
      new Error('AI response is not a valid exploration step (it was not a JSON object).'),
      { kind: 'click', element: 1, reason: 'open' },
    ]);
    const { log } = await explore(fake, agent);
    expect(seen[1]!.history).toEqual([
      '1. (no decision: AI response is not a valid exploration step (it was not a JSON object).)',
    ]);
    expect(log.find((entry) => entry.action === 'click')).toMatchObject({ target: 'Files' });
    expect(log.some((entry) => entry.target.startsWith('agent_failed'))).toBe(false);
  });

  it('scrolls, and refuses a choice the list does not have or a control that is not a list', async () => {
    const fake = fakeBrowser({ ...home(), choice: null });
    const { agent, seen } = scripted([
      { kind: 'scroll', direction: 'down', reason: 'see more' },
      { kind: 'select', element: 2, option: 'Nope', reason: 'choose' },
      { kind: 'select', element: 1, option: 'x', reason: 'choose on a button' },
    ]);
    const { log } = await explore(fake, agent);
    expect(fake.calls).toContain('scroll:down');
    expect(log.some((entry) => entry.action === 'scroll' && entry.target === 'down')).toBe(true);
    const history = seen.at(-1)!.history;
    expect(history[1]).toContain('select: not done (Type has no choice "Nope")');
    expect(history[2]).toContain('select: not done ("Files" is not a drop-down list');
  });

  it('opens pages from a browser that cannot tell its address, and logs a result it cannot read', async () => {
    const fake = fakeBrowser({
      snapshots: [snap('Home'), snap('Home'), new Error('navigating'), snap('Home')],
      screens: [[el(1, 'Files')]],
      url: null,
    });
    const { agent, seen } = scripted([
      { kind: 'goto', url: '/files', reason: 'open' },
      { kind: 'finish', reason: 'done' },
    ]);
    const { log } = await explore(fake, agent);
    // The address is resolved from the one the exploration started on.
    expect(fake.calls).toEqual([`goto:${ORIGIN}/`, `goto:${ORIGIN}/files`]);
    expect(log.find((entry) => entry.reason === 'open')).toMatchObject({ result: null });
    expect(seen[1]!.history).toEqual([`1. navigate "${ORIGIN}/files" -> nothing readable`]);
  });

  it('refuses to choose files', async () => {
    const fake = fakeBrowser({
      snapshots: [snap('Home')],
      screens: [[el(1, 'Attachment', { role: 'input', type: 'file' })]],
    });
    const { agent, seen } = scripted([
      { kind: 'type', element: 1, value: 'a.pdf', reason: 'attach' },
    ]);
    await explore(fake, agent);
    expect(seen[1]!.history).toEqual(['1. type: not done (files cannot be chosen here)']);
  });
});

describe('reading what the model answers', () => {
  it('keeps what is usable of a loose answer: any case, nulls, long texts and numbers', () => {
    const long = 'x'.repeat(900);
    expect(
      readExploreStep(
        JSON.stringify({
          action: ' CLICK ',
          element: '3',
          value: null,
          reason: long,
          plan: [
            { flow: 'Open files', status: 'DONE' },
            { flow: 'Filter', status: 'whatever' },
            { flow: 'No status at all' },
          ],
        }),
      ),
    ).toEqual({
      kind: 'click',
      element: 3,
      reason: 'x'.repeat(600),
      plan: [
        { flow: 'Open files', status: 'done' },
        { flow: 'Filter', status: 'pending' },
        { flow: 'No status at all', status: 'pending' },
      ],
    });
    expect(readExploreStep('{"action":"scroll","direction":"down"}')).toMatchObject({
      direction: 'down',
    });
    expect(readExploreStep('{"action":"scroll","direction":"UP","reason":"r"}')).toEqual({
      kind: 'scroll',
      direction: 'up',
      reason: 'r',
    });
    expect(
      readExploreStep('{"action":"select","element":2,"option":"Reports","reason":"r"}'),
    ).toEqual({ kind: 'select', element: 2, option: 'Reports', reason: 'r' });
    expect(readExploreStep('{"action":"scroll"}')).toEqual({
      kind: 'scroll',
      direction: 'down',
      reason: '',
    });
    expect(readExploreStep('{"action":"type","element":1,"value":42,"reason":"r"}')).toEqual({
      kind: 'type',
      element: 1,
      value: '42',
      reason: 'r',
    });
    // A plan that is not a list is ignored; the action still counts.
    expect(readExploreStep('{"action":"finish","plan":"all"}')).toEqual({
      kind: 'finish',
      reason: '',
    });
  });

  it('says what is wrong with an answer, so the model can fix it', () => {
    expect(readExploreStep('I will click Files')).toMatch(
      /^it was not a JSON object: I will click/,
    );
    expect(readExploreStep('{"action":"hover"}')).toMatch(/^action:/);
    expect(readExploreStep('{"action":"click"}')).toBe('click needs the numeric "element" id');
    expect(readExploreStep('{"action":"select","element":1}')).toBe(
      'select needs the "option" text',
    );
    expect(readExploreStep('{"action":"type","element":1}')).toBe('type needs the "value" text');
    expect(readExploreStep('{"action":"press"}')).toBe('press needs a "key"');
    expect(readExploreStep('{"action":"goto"}')).toBe('goto needs a "url"');
    expect(readExploreStep('{"action":5}')).toMatch(/^action:/);
  });

  it('takes the first object when the answer has more braces after it', () => {
    expect(parseJsonObject('{"a":"}{ \\" x"} Note: {b}')).toEqual({ a: '}{ " x' });
    expect(parseJsonObject('{"a":1} then {"b": oops}')).toEqual({ a: 1 });
    expect(parseJsonObject('{"a": {"b": 1} and {broken')).toBeNull();
    expect(parseJsonObject('{"a": 1')).toBeNull();
  });

  it('shares a budget of context between the documents', () => {
    expect(fitContext([])).toEqual([]);
    const documents = [
      { kind: 'pbi' as const, id: '1', title: 'A', content: 'a'.repeat(5_000) },
      { kind: 'spec' as const, id: '2', title: 'B', content: 'short' },
    ];
    const fitted = fitContext(documents, 2_000);
    expect(fitted[0]!.content).toHaveLength(1_001);
    expect(fitted[0]!.content.endsWith('…')).toBe(true);
    expect(fitted[1]).toEqual({ kind: 'spec', title: 'B', content: 'short' });
    // Many documents still get a readable share.
    expect(
      fitContext(
        Array.from({ length: 50 }, () => documents[0]!),
        2_000,
      )[0]!.content,
    ).toHaveLength(601);
  });
});

describe('AgentE2eAuthor.exploreStep (context and retries)', () => {
  it('gives the model the context the user chose, the plan, and the rules for the flows', async () => {
    const { subject, complete } = author('{"action":"finish","reason":"r"}');
    await subject.exploreStep({
      creation,
      observation: { ...observation, plan: [{ flow: 'Open files', status: 'pending' }] },
      tests: [],
      instructions: null,
      context: [
        { kind: 'pbi', id: 'p1', title: 'PBI 48325', content: 'File filter for download' },
        { kind: 'spec', id: 'c', title: 'Run', content: 'The product specification' },
      ],
    });
    const request = complete.mock.calls[0]![0] as { prompt: string; instruction: string };
    expect(request.prompt).toContain('PBI 48325');
    expect(request.prompt).toContain('File filter for download');
    expect(request.prompt).toContain('The product specification');
    expect(request.prompt).toContain('"flow": "Open files"');
    expect(request.instruction).toContain('PLAN');
    expect(request.instruction).toContain('"action":"select"');
    expect(request.instruction).toContain('"action":"scroll"');
    expect(request.instruction).toContain('ADK teste');
  });

  it('asks the model again, telling it why its first answer was rejected', async () => {
    const answers = ['I would click Files', '{"action":"click","element":1,"reason":"ok"}'];
    const complete = vi.fn(() => Promise.resolve({ text: answers.shift()!, provider: 'fake' }));
    const llm = { provider: 'fake', complete, stream: vi.fn() } as unknown as LlmPort;
    const subject = new AgentE2eAuthor({
      agents: {
        getAgent: vi.fn().mockResolvedValue({ instructions: 'QA', model: 'm1', skills: [] }),
      } as unknown as AgentService,
      providers: {
        resolveLlmProvider: vi.fn().mockResolvedValue(llm),
      } as unknown as DynamicProviderFactory,
    });
    expect(await step(subject)).toEqual({ kind: 'click', element: 1, reason: 'ok' });
    expect(complete).toHaveBeenCalledTimes(2);
    const second = (complete.mock.calls[1] as unknown as [{ prompt: string }])[0].prompt;
    expect(second).toContain('yourPreviousAnswerWasRejected');
    expect(second).toContain('it was not a JSON object');
  });

  it('explores as the agent it is told to, with its instructions, skills and model', async () => {
    const complete = vi.fn((_request: { prompt: string; instruction?: string }) =>
      Promise.resolve({ text: '{"action":"finish","reason":"r"}', provider: 'fake' }),
    );
    const llm = { provider: 'fake', complete, stream: vi.fn() } as unknown as LlmPort;
    const getAgent = vi.fn().mockResolvedValue({
      instructions: 'You are the explorer.',
      model: 'explorer-model',
      skills: [
        {
          name: 'test-design',
          description: 'Designing test cases',
          instructions: 'Cover boundaries first.',
          version: '1',
          revision: 'r1',
        },
      ],
    });
    const resolveLlmProvider = vi.fn().mockResolvedValue(llm);
    const subject = new AgentE2eAuthor({
      agents: { getAgent } as unknown as AgentService,
      providers: { resolveLlmProvider } as unknown as DynamicProviderFactory,
    });
    await subject.exploreStep({
      creation,
      observation,
      tests: [],
      instructions: null,
      agentId: 'explorer',
    });
    // The chosen agent, not the one of the run.
    expect(getAgent).toHaveBeenCalledWith('ws', 'explorer');
    expect(resolveLlmProvider).toHaveBeenCalledWith(
      'owner',
      undefined,
      undefined,
      'explorer-model',
    );
    const instruction = (complete.mock.calls[0]![0] as { instruction: string }).instruction;
    expect(instruction).toContain('You are the explorer.');
    expect(instruction).toContain('<skill name="test-design">');
    expect(instruction).toContain('Cover boundaries first.');
    // Its persona leads and the exploration's rules follow.
    expect(instruction.indexOf('You are the explorer.')).toBeLessThan(
      instruction.indexOf('Cover boundaries first.'),
    );
    expect(instruction.indexOf('Cover boundaries first.')).toBeLessThan(
      instruction.indexOf('E2E Automation task'),
    );
  });

  it('uses the agent of the run when none is chosen, and adds no skills when it has none', async () => {
    const { subject, complete } = author('{"action":"finish","reason":"r"}');
    await step(subject);
    const instruction = (complete.mock.calls[0]![0] as { instruction: string }).instruction;
    expect(instruction).toContain('You are QA.');
    expect(instruction).not.toContain('<skill');
  });

  it('gives up after two bad answers and says what was wrong with the last', async () => {
    await expect(step(author('not json at all').subject)).rejects.toMatchObject({
      code: 'E2E_EXPLORE_ACTION_INVALID',
      message: expect.stringContaining('it was not a JSON object: not json at all'),
    });
  });
});

describe('recording the exploration as a video', () => {
  /** Makes the fake browser write a recording into the folder it was asked to record to. */
  function recordsInto(fake: ReturnType<typeof fakeBrowser>, content: string | Buffer) {
    const page = fake.page as Record<string, unknown>;
    const closed = vi.fn(() => Promise.resolve());
    page.close = closed;
    page.video = () => ({
      path: async () => {
        const file = path.join(fake.pageOptions[0]!.recordVideo!.dir, 'v.webm');
        await fs.writeFile(file, content);
        return file;
      },
    });
    return closed;
  }
  const videos = (events: E2eExploreEvent[]) =>
    events.flatMap((event) => (event.kind === 'video' ? [event] : []));
  const site = () =>
    fakeBrowser({
      snapshots: [snap('Home')],
      screens: [[el(1, 'Files')]],
      areas: ['Files', 'Reports'],
    });

  it('records the browser of the agent, sends the video at the end and removes the folder', async () => {
    const fake = site();
    const closed = recordsInto(fake, 'webm-bytes');
    const { events } = await explore(fake, scripted([]).agent, {}, { explorers: 1 });
    const dir = fake.pageOptions[0]!.recordVideo!.dir;
    expect(fake.pageOptions[0]!.recordVideo!.size).toEqual({ width: 1280, height: 720 });
    expect(videos(events)).toEqual([
      expect.objectContaining({ worker: 1, video: Buffer.from('webm-bytes') }),
    ]);
    // The video is the last thing: the page is closed so it is written.
    expect(events.at(-1)!.kind).toBe('video');
    expect(closed).toHaveBeenCalled();
    await expect(fs.access(dir)).rejects.toThrow();
  });

  it('sends one video for each browser that explored', async () => {
    const fake = site();
    recordsInto(fake, 'webm');
    const { events } = await explore(fake, scripted([]).agent, {}, { explorers: 2 });
    expect(videos(events).map((event) => event.worker)).toEqual([1, 2]);
  });

  it('does not record a browser without the agent', async () => {
    const fake = site();
    await new PlaywrightE2eRunner({ loadPlaywright: fake.loadPlaywright, settleMs: 0 }).explore({
      mode: 'frontend',
      url: `${ORIGIN}/`,
    });
    expect(fake.pageOptions[0]).not.toHaveProperty('recordVideo');
  });

  it('shows no video of a recording that is missing, empty, too big or unreadable', async () => {
    const missing = site();
    (missing.page as Record<string, unknown>).video = () => null;
    expect(videos((await explore(missing, scripted([]).agent)).events)).toEqual([]);

    const noFile = site();
    (noFile.page as Record<string, unknown>).video = () => ({ path: () => Promise.resolve('') });
    expect(videos((await explore(noFile, scripted([]).agent)).events)).toEqual([]);

    const empty = site();
    recordsInto(empty, '');
    expect(videos((await explore(empty, scripted([]).agent)).events)).toEqual([]);

    const big = site();
    recordsInto(big, Buffer.alloc(50_000_001));
    expect(videos((await explore(big, scripted([]).agent)).events)).toEqual([]);

    const broken = site();
    (broken.page as Record<string, unknown>).video = () => ({
      path: () => Promise.reject(new Error('not written')),
    });
    const result = await explore(broken, scripted([]).agent);
    expect(videos(result.events)).toEqual([]);
    expect(result.snapshot.pages).toHaveLength(1);
  });

  it('explores without a video when the recording folder cannot be created', async () => {
    const fake = site();
    const spy = vi.spyOn(fs, 'mkdtemp').mockRejectedValueOnce(new Error('disk full'));
    const { events } = await explore(fake, scripted([]).agent);
    spy.mockRestore();
    expect(fake.pageOptions[0]).not.toHaveProperty('recordVideo');
    expect(videos(events)).toEqual([]);
  });
});

describe('keeping the videos of an exploration', () => {
  const run = { workspaceId: 'ws', id: 'run' } as E2eCreation;
  const start = async (transcoder?: {
    toMp4: (video: Uint8Array) => Promise<Uint8Array | null>;
  }) => {
    const artifacts = new InMemoryE2eArtifactStore();
    const recorder = await ExplorationRecorder.start(artifacts, run, false, Date.now, {
      ...(transcoder ? { transcoder } : {}),
    });
    return { artifacts, recorder };
  };

  it('stores each recording as MP4 when it can be converted, in the order of the browsers', async () => {
    const toMp4 = vi.fn(async (video: Uint8Array) => Buffer.from(`mp4:${Buffer.from(video)}`));
    const { artifacts, recorder } = await start({ toMp4 });
    recorder.onProgress({ kind: 'video', worker: 2, video: Buffer.from('b') });
    recorder.onProgress({ kind: 'video', worker: 1, video: Buffer.from('a') });
    await recorder.finish();
    const state = await readExploration(artifacts, run);
    expect(state!.videos).toEqual([
      { worker: 1, mimeType: 'video/mp4' },
      { worker: 2, mimeType: 'video/mp4' },
    ]);
    expect((await artifacts.get('ws/run/exploration/video-1.mp4'))!.toString()).toBe('mp4:a');
  });

  it('keeps the WebM when there is no converter or it cannot convert', async () => {
    for (const transcoder of [undefined, { toMp4: async () => null }]) {
      const { artifacts, recorder } = await start(transcoder);
      recorder.onProgress({ kind: 'video', worker: 1, video: Buffer.from('raw') });
      await recorder.finish();
      expect((await readExploration(artifacts, run))!.videos).toEqual([
        { worker: 1, mimeType: 'video/webm' },
      ]);
      expect((await artifacts.get('ws/run/exploration/video-1.webm'))!.toString()).toBe('raw');
    }
  });

  it('goes on without the video when it cannot be stored', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { artifacts, recorder } = await start({
      toMp4: () => Promise.reject(new Error('ffmpeg missing')),
    });
    recorder.onProgress({ kind: 'video', worker: 1, video: Buffer.from('raw') });
    await recorder.finish();
    const state = await readExploration(artifacts, run);
    expect(state).toMatchObject({ status: 'ready' });
    expect(state).not.toHaveProperty('videos');
    error.mockRestore();
  });
});
