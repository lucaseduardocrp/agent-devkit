import type { E2eMode } from '../domain/e2e-mode.js';
import type { AccessServiceToken } from './access-routing.js';

export interface E2ePageSnapshot {
  readonly url: string;
  readonly title: string;
  readonly headings: readonly string[];
  readonly buttons: readonly string[];
  readonly links: readonly { readonly text: string; readonly href: string }[];
  readonly fields: readonly string[];
  readonly testIds: readonly string[];
}

export interface E2eApiSnapshot {
  readonly status: number;
  readonly contentType: string;
  readonly excerpt: string;
  readonly specUrl?: string;
  readonly spec?: string;
}

export interface E2eSnapshot {
  readonly startUrl: string;
  readonly pages: readonly E2ePageSnapshot[];
  readonly api?: E2eApiSnapshot;
}

export interface E2eCredentials {
  readonly username: string | null;
  readonly password: string | null;
}

/**
 * Before Run prepares the preconditions of the test and After Run removes what it left
 * behind. Each is a module exporting one default async function; null when the test has none.
 */
export interface E2eRunHooks {
  readonly beforeRun: string | null;
  readonly afterRun: string | null;
}

export interface E2eRunInput {
  readonly script: string;
  readonly hooks?: E2eRunHooks | null;
  readonly mode: E2eMode;
  readonly baseUrl: string;
  readonly localOrigin?: string | null;
  readonly locale: string;
  readonly credentials: E2eCredentials;
  readonly accessToken?: AccessServiceToken | null;
  readonly signal?: AbortSignal;
  /** Custom variables of the run's environment; a spec reads `KEY` as `process.env.E2E_VAR_KEY`. */
  readonly variables?: Readonly<Record<string, string>>;
  /** Called while a UI test runs with the latest frame of its browser and what it is doing. */
  readonly onLive?: (frame: E2eLiveFrame) => void;
}

export type E2eRunTouchAction =
  'click' | 'type' | 'press' | 'check' | 'uncheck' | 'select' | 'hover';

/** The action a running test is on: which step, and what it does to which element. */
export interface E2eLiveActivity {
  readonly step: number;
  readonly action: E2eRunTouchAction;
  /** "button", "field", "link"... */
  readonly kind: string;
  readonly name: string;
}

export interface E2eLiveFrame {
  /** JPEG of the page. */
  readonly image: Uint8Array;
  /** Null before the first action. */
  readonly activity: E2eLiveActivity | null;
}

/** A page the test went through, in the order it first got there. */
export interface E2eTrailPage {
  readonly index: number;
  readonly url: string;
  readonly title: string;
  /** JPEG of the page when the test first got to it. */
  readonly screenshot: Uint8Array | null;
}

/** An element the test acted on. */
export interface E2eTrailElement {
  readonly index: number;
  readonly pageIndex: number;
  readonly kind: string;
  readonly name: string;
  /** Part of the viewport the element occupied, each value between 0 and 1. */
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
  /** JPEG of the page right before the first action on the element. */
  readonly screenshot: Uint8Array | null;
}

export interface E2eTrailTouch {
  /** Milliseconds since the test started. */
  readonly atMs: number;
  /** Top-level step the touch belongs to; 0 outside the steps. */
  readonly step: number;
  readonly action: E2eRunTouchAction;
  readonly pageIndex: number;
  readonly elementIndex: number | null;
  /** Text typed or option chosen, with secrets masked. */
  readonly value: string | null;
}

/** Everything a UI test touched, page by page. */
export interface E2eTrail {
  readonly pages: readonly E2eTrailPage[];
  readonly elements: readonly E2eTrailElement[];
  readonly touches: readonly E2eTrailTouch[];
  /** Page indexes in the order the test was on them; a page repeats when revisited. */
  readonly visits: readonly number[];
}

export interface E2eRunResult {
  readonly status: 'passed' | 'failed';
  readonly durationMs: number;
  readonly error: string | null;
  readonly logs: string;
  readonly video: Uint8Array | null;
  /** One entry per top-level `test.step`, in execution order. */
  readonly steps: readonly E2eStepEvidence[];
  /** Computer of the local runner that executed the spec; absent on the ADK workers. */
  readonly executedOn?: string | null;
  /** Pages and elements the test touched (UI tests run by the ADK workers). */
  readonly trail?: E2eTrail | null;
}

export interface E2eStepEvidence {
  readonly position: number;
  readonly title: string;
  readonly status: 'passed' | 'failed';
  readonly durationMs: number;
  readonly error: string | null;
  /** PNG of the page when the step ended (UI tests only). */
  readonly screenshot: Uint8Array | null;
}

/** What the agent reports while it explores a site, so the exploration can be followed live. */
export type E2eExploreEvent =
  | { readonly kind: 'phase'; readonly phase: 'signing_in' | 'exploring' }
  | {
      readonly kind: 'log';
      readonly action: 'navigate' | 'sign_in' | 'click';
      readonly target: string;
      /** Name of the page the action led to. */
      readonly result: string | null;
    }
  | {
      readonly kind: 'page';
      readonly page: E2ePageSnapshot;
      /** JPEG of the page. */
      readonly screenshot: Uint8Array | null;
    }
  | { readonly kind: 'frame'; readonly image: Uint8Array };

const FOCUS_STOPWORDS = new Set(
  (
    'the and for with only just all whole entire site page pages screen screens app application ' +
    'bug bugs fix feature features explore exploring test tests about from into this that ' +
    'que para com dos das uma uns umas por sem sobre site pagina paginas tela telas inteiro ' +
    'inteira todo toda todos todas apenas somente explorar'
  ).split(' '),
);

/**
 * What the agent looks for in the controls of the site, taken from the description it was
 * given: lowercase words without accents, minus filler like "the whole site". Empty means the
 * description names nothing specific, so the exploration stays open.
 */
export function focusKeywords(focus: string | null | undefined): string[] {
  const words = (focus ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !FOCUS_STOPWORDS.has(word));
  return [...new Set(words)].slice(0, 8);
}

export interface E2eExploreInput {
  mode: E2eMode;
  url: string;
  transportUrl?: string;
  signal?: AbortSignal;
  accessToken?: AccessServiceToken | null;
  /** Test account the agent signs in with when the site opens on a sign-in form. */
  credentials?: E2eCredentials | null;
  /**
   * What the exploration should cover (a feature, a bug…). Controls and links that match its
   * keywords are explored first and the rest only briefly; empty keywords leave it open.
   */
  focus?: string | null;
  /**
   * Maps the whole application instead of sampling it: far more links, clicks, pages and time.
   * Used for the Source of a workspace, which is meant to hold every flow the agent can reach.
   */
  thorough?: boolean;
  /** Follows the exploration of a UI; events arrive in order. */
  onProgress?: (event: E2eExploreEvent) => void;
}

export interface E2eRunner {
  explore(input: E2eExploreInput): Promise<E2eSnapshot>;
  run(input: E2eRunInput): Promise<E2eRunResult>;
}

/** Converts recordings to a widely playable format; returns null when conversion fails. */
export interface E2eVideoTranscoder {
  toMp4(webm: Uint8Array): Promise<Uint8Array | null>;
}

export type E2eRunnerErrorCode =
  | 'E2E_BROWSER_NOT_INSTALLED'
  | 'E2E_TARGET_UNREACHABLE'
  | 'E2E_RUNNER_FAILED'
  | 'E2E_LOCAL_RUNNER_UNAVAILABLE'
  | 'E2E_LOCAL_RUNNER_LOST';

export class E2eRunnerError extends Error {
  constructor(
    public readonly code: E2eRunnerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'E2eRunnerError';
  }
}

const SECRET_PATTERN =
  /(authorization|token|password|secret|cookie)(["']?\s*[:=]\s*["']?)(?:(?:bearer|basic)\s+)?[^\s,;"']+/gi;

/** Removes known credential values and common secret shapes from runner output. */
export function redact(value: string, secrets: readonly (string | null | undefined)[]): string {
  let result = value.replace(SECRET_PATTERN, '$1$2[redacted]');
  for (const secret of secrets) {
    if (secret && secret.length >= 3) result = result.split(secret).join('[redacted]');
  }
  return result;
}

export function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}
