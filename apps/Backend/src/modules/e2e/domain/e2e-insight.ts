import { ApplicationError } from '../../../shared/errors.js';
import { type E2eCreation, type E2eTestCase, type E2eTestStatus } from './e2e.js';

/**
 * Where an application runs and how the agent signs in to it. Saved once per workspace and
 * reused by the runs: the first one is the default.
 */
export interface E2eEnvironment {
  id: string;
  workspaceId: string;
  name: string;
  baseUrl: string;
  username: string | null;
  /** AES-GCM ciphertext; never returned by the API. */
  passwordSecret: string | null;
  /** AES-GCM ciphertext of a JSON object `{ KEY: value }`; values never leave the backend. */
  variablesSecret: string | null;
  /** Names of the custom variables, kept in clear so they can be listed. */
  variableNames: string[];
  createdAt: Date;
  updatedAt: Date;
}

export const MAX_ENVIRONMENT_VARIABLES = 30;
/** Specs read a custom variable `KEY` as `process.env.E2E_VAR_KEY`. */
export const VARIABLE_ENV_PREFIX = 'E2E_VAR_';
const VARIABLE_NAME = /^[A-Z][A-Z0-9_]{0,59}$/;

/** Uppercases variable names and rejects what could not be an environment variable. */
export function normalizeVariables(
  variables: readonly { readonly key: string; readonly value: string }[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of variables) {
    const key = item.key.trim().toUpperCase();
    if (!VARIABLE_NAME.test(key) || key in result)
      throw new ApplicationError(
        'E2E_INVALID_VARIABLE',
        'Variable names use letters, digits and underscores, start with a letter and are unique.',
        400,
        [{ field: 'variables', key: item.key }],
      );
    result[key] = item.value;
  }
  return result;
}

// --- Exploration: the agent signs in and browses the site before the tests are planned. ---

/** The phase the agent is in; planning the tests belongs to the run, not to the exploration. */
export type E2eExplorationStatus = 'signing_in' | 'exploring' | 'ready' | 'failed';
export type E2eExplorationAction = 'navigate' | 'sign_in' | 'click';

export interface E2eExplorationPage {
  /** Position in the exploration, starting at 1; also names its screenshot. */
  readonly index: number;
  readonly url: string;
  readonly title: string;
  readonly summary: string;
  /** Names of the main controls of the page. */
  readonly elements: readonly string[];
  readonly hasScreenshot: boolean;
}

export interface E2eExplorationLogEntry {
  /** Milliseconds since the exploration started. */
  readonly atMs: number;
  readonly action: E2eExplorationAction;
  readonly target: string;
  /** What the agent saw after the action. */
  readonly result: string | null;
}

export const MAX_EXPLORATION_DESCRIPTION = 2_000;

export interface E2eExploration {
  readonly status: E2eExplorationStatus;
  /** What the user asked to explore (the whole site, one feature, a bug…); null when open. */
  readonly description?: string | null;
  /** True when the exploration replaces the Source of the workspace when it ends well. */
  readonly source?: boolean;
  /** Where the script ended up: "database" or "source". Scripts never go to the repository. */
  readonly savedTo?: string | null;
  /** Why the script could not be kept (for instance a failed commit); null when it was. */
  readonly saveError?: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  /** How long the sign-in took; null when the agent did not sign in. */
  readonly signedInMs: number | null;
  readonly finishedAt: string | null;
  readonly error: string | null;
  readonly pages: readonly E2eExplorationPage[];
  readonly log: readonly E2eExplorationLogEntry[];
  /** True while a recent frame of the agent's browser is available. */
  readonly hasLiveFrame: boolean;
}

/**
 * The script of a finished exploration, kept in the database: what the agent did, in order,
 * and the pages it reached. Unlike the live state of a run it is never replaced by the next
 * exploration, so other tests can look it up.
 */
export interface E2eExplorationScript {
  readonly id: string;
  readonly workspaceId: string;
  readonly creationId: string;
  readonly description: string | null;
  readonly status: 'ready' | 'failed';
  readonly error: string | null;
  readonly signedInMs: number | null;
  readonly script: readonly E2eExplorationLogEntry[];
  readonly pages: readonly E2eExplorationPage[];
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly createdAt: Date;
}

export type NewE2eExplorationScript = Omit<E2eExplorationScript, 'id' | 'createdAt'>;

type CreationRef = Pick<E2eCreation, 'workspaceId' | 'id'>;

export function explorationPrefix(creation: CreationRef): string {
  return `${creation.workspaceId}/${creation.id}/exploration`;
}
export function explorationStateKey(creation: CreationRef): string {
  return `${explorationPrefix(creation)}/state.json`;
}
export function explorationLiveKey(creation: CreationRef): string {
  return `${explorationPrefix(creation)}/live.jpg`;
}
export function explorationPageKey(creation: CreationRef, index: number): string {
  return `${explorationPrefix(creation)}/page-${String(index).padStart(2, '0')}.jpg`;
}

// --- Action trail: what a test touched while it ran, page by page. ---

export type E2eTouchAction = 'click' | 'type' | 'press' | 'check' | 'uncheck' | 'select' | 'hover';
export const TOUCH_ACTIONS: readonly E2eTouchAction[] = [
  'click',
  'type',
  'press',
  'check',
  'uncheck',
  'select',
  'hover',
];

/** Part of the viewport an element occupies, each value between 0 and 1. */
export interface E2eTrailBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface E2eStoredTrailPage {
  readonly index: number;
  readonly url: string;
  readonly title: string;
  readonly hasScreenshot: boolean;
}

export interface E2eStoredTrailElement {
  readonly index: number;
  readonly pageIndex: number;
  /** "Button", "Field", "Link"... */
  readonly kind: string;
  readonly name: string;
  readonly box: E2eTrailBox | null;
  readonly hasScreenshot: boolean;
}

export interface E2eStoredTrailTouch {
  readonly atMs: number;
  /** Top-level step of the test the touch belongs to; 0 outside the steps. */
  readonly step: number;
  readonly action: E2eTouchAction;
  readonly pageIndex: number;
  readonly elementIndex: number | null;
  /** Text typed or option chosen; secrets are masked by the runner. */
  readonly value: string | null;
}

/** The trail of a test's latest execution as kept in the artifact store. */
export interface E2eStoredTrail {
  readonly pages: readonly E2eStoredTrailPage[];
  readonly elements: readonly E2eStoredTrailElement[];
  readonly touches: readonly E2eStoredTrailTouch[];
  /** Page indexes in the order the test was on them; a page repeats when revisited. */
  readonly visits: readonly number[];
}

/** The action a running test is on, kept next to its live frame. */
export interface E2eLiveActivity {
  readonly step: number;
  readonly action: E2eTouchAction;
  readonly kind: string;
  readonly name: string;
}

type TestRef = Pick<E2eTestCase, 'workspaceId' | 'creationId' | 'id'>;

export function trailPrefix(test: TestRef): string {
  return `${test.workspaceId}/${test.creationId}/trail/${test.id}`;
}
export function trailKey(test: TestRef): string {
  return `${trailPrefix(test)}/trail.json`;
}
export function trailImageKey(test: TestRef, kind: 'page' | 'element', index: number): string {
  return `${trailPrefix(test)}/${kind}-${String(index).padStart(3, '0')}.jpg`;
}
export function liveFrameKey(test: TestRef): string {
  return `${test.workspaceId}/${test.creationId}/live/${test.id}.jpg`;
}
export function liveLabelKey(test: TestRef): string {
  return `${test.workspaceId}/${test.creationId}/live/${test.id}.json`;
}

// --- Action map: the trails of a run's tests merged into one graph of pages. ---

export interface E2eMapTouch {
  readonly testId: string;
  readonly step: number;
  readonly action: E2eTouchAction;
  readonly value: string | null;
}

export interface E2eMapElement {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly box: E2eTrailBox | null;
  /** Test and element index whose screenshot shows the element; null when none was taken. */
  readonly image: { readonly testId: string; readonly index: number } | null;
  readonly touches: readonly E2eMapTouch[];
}

export interface E2eMapPage {
  readonly id: string;
  /** Path of the page inside the application, with its query string. */
  readonly path: string;
  readonly title: string;
  readonly image: { readonly testId: string; readonly index: number } | null;
  readonly testIds: readonly string[];
  readonly touches: number;
  /** Tests whose failing execution ended on this page. */
  readonly failedTestIds: readonly string[];
  readonly elements: readonly E2eMapElement[];
}

export interface E2eMapEdge {
  /** Null for the edge that leaves the start of the run. */
  readonly from: string | null;
  readonly to: string;
  readonly testIds: readonly string[];
}

export interface E2eMapTest {
  readonly id: string;
  readonly status: E2eTestStatus;
  /** Pages in the order the test went through them; a page repeats when revisited. */
  readonly path: readonly string[];
  /** What the test is doing right now, while it runs. */
  readonly live: E2eLiveActivity | null;
}

export interface E2eActionMap {
  readonly pages: readonly E2eMapPage[];
  readonly edges: readonly E2eMapEdge[];
  readonly tests: readonly E2eMapTest[];
}

/** Pages are the same when they share the address (without the origin and hash) and the title. */
function pageId(url: string, title: string): { id: string; path: string } {
  let path = url;
  try {
    const parsed = new URL(url);
    path = `${parsed.pathname}${parsed.search}`;
  } catch {
    // Kept as recorded when the address has no path to extract.
  }
  return { id: `${path} | ${title}`, path };
}

export interface TestTrail {
  readonly test: Pick<E2eTestCase, 'id' | 'status'>;
  readonly trail: E2eStoredTrail | null;
  readonly live?: E2eLiveActivity | null;
}

interface PageDraft extends Omit<E2eMapPage, 'testIds' | 'elements' | 'failedTestIds'> {
  image: E2eMapPage['image'];
  touches: number;
  readonly testIds: Set<string>;
  readonly failedTestIds: string[];
  readonly elements: Map<string, E2eMapElement & { readonly touches: E2eMapTouch[] }>;
}

/** Merges the trails of a run's tests into the graph the run view draws. */
export function buildActionMap(trails: readonly TestTrail[]): E2eActionMap {
  const pages = new Map<string, PageDraft>();
  const edges = new Map<string, { from: string | null; to: string; testIds: Set<string> }>();
  const tests: E2eMapTest[] = [];

  for (const { test, trail, live } of trails) {
    const idOf = new Map<number, string>();
    for (const page of trail?.pages ?? []) {
      const { id, path } = pageId(page.url, page.title);
      idOf.set(page.index, id);
      let draft = pages.get(id);
      if (!draft) {
        draft = {
          id,
          path,
          title: page.title,
          image: null,
          testIds: new Set(),
          touches: 0,
          failedTestIds: [],
          elements: new Map(),
        };
        pages.set(id, draft);
      }
      if (!draft.image && page.hasScreenshot) draft.image = { testId: test.id, index: page.index };
      draft.testIds.add(test.id);
    }

    const path: string[] = [];
    for (const index of trail?.visits ?? []) {
      const id = idOf.get(index);
      const previous = path.at(-1) ?? null;
      if (!id || id === previous) continue;
      const key = `${previous ?? ''} > ${id}`;
      const edge = edges.get(key) ?? { from: previous, to: id, testIds: new Set<string>() };
      edge.testIds.add(test.id);
      edges.set(key, edge);
      path.push(id);
    }

    const elementOf = new Map<number, E2eStoredTrailElement>();
    for (const element of trail?.elements ?? []) elementOf.set(element.index, element);
    for (const touch of trail?.touches ?? []) {
      const page = pages.get(idOf.get(touch.pageIndex) ?? '');
      if (!page) continue;
      page.touches += 1;
      const element = touch.elementIndex === null ? undefined : elementOf.get(touch.elementIndex);
      if (!element) continue;
      const elementId = `${page.id} | ${element.kind} | ${element.name}`;
      let merged = page.elements.get(elementId);
      if (!merged) {
        merged = {
          id: elementId,
          kind: element.kind,
          name: element.name,
          box: element.box,
          image: element.hasScreenshot ? { testId: test.id, index: element.index } : null,
          touches: [],
        };
        page.elements.set(elementId, merged);
      }
      merged.touches.push({
        testId: test.id,
        step: touch.step,
        action: touch.action,
        value: touch.value,
      });
    }

    const last = pages.get(path.at(-1) ?? '');
    if (last && (test.status === 'failed' || test.status === 'error'))
      last.failedTestIds.push(test.id);
    tests.push({ id: test.id, status: test.status, path, live: live ?? null });
  }

  return {
    pages: [...pages.values()].map((page) => ({
      ...page,
      testIds: [...page.testIds],
      elements: [...page.elements.values()],
    })),
    edges: [...edges.values()].map((edge) => ({ ...edge, testIds: [...edge.testIds] })),
    tests,
  };
}
