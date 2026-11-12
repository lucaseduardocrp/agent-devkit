import type {
  E2eActionMap,
  E2eExplorationLogEntry,
  E2eExplorationPage,
  E2eMapEdge,
  E2eMapPage,
} from './e2e-insight.js';

/**
 * The Source of a workspace: what the agent did and the pages it reached the last time it
 * explored the application as a whole. There is one per workspace; every new Source exploration
 * replaces it, so it always describes the application as it is now.
 */
export interface E2eSource {
  readonly workspaceId: string;
  /** Hidden run that explored the application; its jobs are the Source's jobs. */
  readonly creationId: string;
  /** Saved environment whose application was explored; null when it was deleted. */
  readonly environmentId: string | null;
  readonly startUrl: string;
  readonly signedInMs: number | null;
  readonly script: readonly E2eExplorationLogEntry[];
  readonly pages: readonly E2eExplorationPage[];
  /** Overview of the system and its flows, written by the AI; null when it could not be. */
  readonly documentation: E2eSourceDocumentation | null;
  /** Why the documentation could not be written; null when it was. */
  readonly documentationError: string | null;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly updatedAt: Date;
}

/** Where a documented flow comes from: the Brain, what the agent found in the browser, or both. */
export type E2eSourceFlowOrigin = 'documented' | 'discovered' | 'both';

export interface E2eSourceDocumentedFlow {
  readonly title: string;
  readonly description: string;
  readonly steps: readonly string[];
  /** Names of the pages the flow goes through. */
  readonly pages: readonly string[];
  readonly origin: E2eSourceFlowOrigin;
}

/** A feature area of the system and every flow known in it. */
export interface E2eSourceArea {
  readonly name: string;
  readonly description: string;
  readonly flows: readonly E2eSourceDocumentedFlow[];
}

/**
 * The documentation of the system: what it is and every flow it has, written by the AI from the
 * whole Brain and from what the agent discovered while exploring the application.
 */
export interface E2eSourceDocumentation {
  /** Markdown: what the system is, who uses it, its modules and main rules. */
  readonly overview: string;
  readonly areas: readonly E2eSourceArea[];
  /** Brain documents the documentation was written from. */
  readonly brainDocuments: readonly { readonly title: string; readonly source: string }[];
  readonly generatedAt: string;
}

export type NewE2eSource = Omit<E2eSource, 'updatedAt'>;

export function sourcePrefix(workspaceId: string): string {
  return `${workspaceId}/source`;
}
export function sourcePageKey(workspaceId: string, index: number): string {
  return `${sourcePrefix(workspaceId)}/page-${String(index).padStart(2, '0')}.jpg`;
}

/** `testId` of the page pictures of a Source map: they belong to the Source, not to a test. */
export const SOURCE_IMAGE_OWNER = 'source';

/** What the agent discovered, as the AI receives it: the pages with their controls and the path taken. */
export function sourceDiscovery(source: Pick<E2eSource, 'pages' | 'script'>) {
  return {
    discoveredPages: source.pages.map((page) => ({
      name: page.title,
      url: page.url,
      summary: page.summary,
      controls: page.elements,
    })),
    discoveredNavigation: source.script.map((entry) => ({
      action: entry.action,
      target: entry.target,
      ledTo: entry.result,
    })),
  };
}

/** One way through the application: the action that ends it and the pages it goes through. */
export interface E2eSourceFlow {
  readonly id: string;
  /** Position of the action in the script, starting at 1. */
  readonly step: number;
  readonly action: E2eExplorationLogEntry['action'];
  /** What the agent opened, signed in as or clicked. */
  readonly target: string;
  /** Name of the page the flow ends on; flows are grouped by it. */
  readonly group: string;
}

export interface E2eSourceMap {
  /** The same graph a run draws, with one "test" per flow. */
  readonly map: E2eActionMap;
  readonly flows: readonly E2eSourceFlow[];
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/**
 * Turns the script of the Source into its flows: every action that led to a page is a flow that
 * goes from the start of the application to that page. Links are opened from the first screen
 * (after signing in) and clicks continue from the page the previous action ended on.
 */
export function buildSourceMap(source: Pick<E2eSource, 'script' | 'pages'>): E2eSourceMap {
  const byName = new Map<string, E2eExplorationPage>();
  for (const page of source.pages) if (!byName.has(page.title)) byName.set(page.title, page);
  const idOf = (page: E2eExplorationPage) => String(page.index);

  /** The first way the agent got to each page. */
  const reached = new Map<string, readonly string[]>();
  const used = new Map<string, { testIds: string[]; touches: number }>();
  const edges = new Map<string, { from: string | null; to: string; testIds: string[] }>();
  const flows: E2eSourceFlow[] = [];
  const tests: E2eActionMap['tests'][number][] = [];
  /** Where links are opened from, and where the next click starts. */
  let home: string | null = null;
  let current: string | null = null;

  source.script.forEach((entry, position) => {
    const page = entry.result === null ? undefined : byName.get(entry.result);
    if (!page) return;
    const to = idOf(page);
    const from = entry.action === 'navigate' ? home : current;
    const before = from === null ? [] : reached.get(from)!;
    const path = from === to ? before : [...before, to];
    if (!reached.has(to)) reached.set(to, path);
    if (entry.action === 'sign_in' || home === null) home = to;
    // After a link the agent goes back to the first screen; a click stays where it led.
    current = entry.action === 'navigate' ? home : to;

    const id = `flow-${position + 1}`;
    flows.push({
      id,
      step: position + 1,
      action: entry.action,
      target: entry.target,
      group: page.title,
    });
    tests.push({ id, status: 'passed', path, live: null });
    path.forEach((pageId, index) => {
      const usage = used.get(pageId) ?? { testIds: [], touches: 0 };
      usage.testIds.push(id);
      used.set(pageId, usage);
      const previous = index === 0 ? null : path[index - 1]!;
      const key = `${previous ?? ''}>${pageId}`;
      const edge = edges.get(key) ?? { from: previous, to: pageId, testIds: [] };
      edge.testIds.push(id);
      edges.set(key, edge);
    });
    // The action happened on the page the flow left from (the page itself when it opened it).
    used.get(from ?? to)!.touches += 1;
  });

  const pages: E2eMapPage[] = source.pages.map((page) => ({
    id: idOf(page),
    path: pathOf(page.url),
    title: page.title,
    image: page.hasScreenshot ? { testId: SOURCE_IMAGE_OWNER, index: page.index } : null,
    testIds: used.get(idOf(page))?.testIds ?? [],
    touches: used.get(idOf(page))?.touches ?? 0,
    failedTestIds: [],
    elements: [],
  }));
  return { map: { pages, edges: [...edges.values()] satisfies E2eMapEdge[], tests }, flows };
}
