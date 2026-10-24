// Shared by the ADK workers and `devkit runner` (copied into apps/Cli/src/vendor/apitests by
// apps/Cli/scripts/sync-apitests-engine.mjs). Keep these files dependency-free: no imports from
// outside this folder, only Node built-ins.

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface KeyValue {
  readonly key: string;
  readonly value: string;
  /** Disabled entries are kept for editing but never sent. */
  readonly enabled?: boolean;
}

export interface Variable extends KeyValue {
  /** Masked in results and exports; stored encrypted. */
  readonly secret?: boolean;
}

export type RequestBody =
  | { readonly mode: 'none' }
  | { readonly mode: 'json' | 'text' | 'xml'; readonly content: string }
  | { readonly mode: 'form' | 'urlencoded'; readonly fields: readonly KeyValue[] };

export type RequestAuth =
  | { readonly type: 'none' }
  /** Uses the auth of the parent folder or collection. */
  | { readonly type: 'inherit' }
  | { readonly type: 'bearer'; readonly token: string }
  | { readonly type: 'basic'; readonly username: string; readonly password: string }
  | {
      readonly type: 'apikey';
      readonly key: string;
      readonly value: string;
      readonly in: 'header' | 'query';
    };

export const ASSERTION_SOURCES = ['status', 'header', 'body', 'json', 'duration'] as const;
export const ASSERTION_OPERATORS = [
  'eq',
  'neq',
  'contains',
  'notContains',
  'exists',
  'notExists',
  'lt',
  'lte',
  'gt',
  'gte',
  'matches',
  'isType',
] as const;

export interface Assertion {
  readonly id: string;
  /** What is checked: the status code, a header, the raw body, a JSON path or the duration (ms). */
  readonly source: (typeof ASSERTION_SOURCES)[number];
  /** Header name or JSON path (`data.items[0].id`, `$.token`). */
  readonly path?: string;
  readonly operator: (typeof ASSERTION_OPERATORS)[number];
  readonly expected?: string;
}

/** Saves part of a response into a variable for the next requests (e.g. a token or an id). */
export interface Capture {
  readonly variable: string;
  readonly source: 'json' | 'header' | 'status' | 'body';
  readonly path?: string;
}

export interface ApiRequestSpec {
  readonly id: string;
  readonly type: 'request';
  readonly name: string;
  readonly description?: string;
  readonly method: HttpMethod;
  readonly url: string;
  /** Values of the `:name` segments of the URL path, as in Postman and Bruno. */
  readonly pathParams?: readonly KeyValue[];
  readonly headers: readonly KeyValue[];
  readonly query: readonly KeyValue[];
  readonly body: RequestBody;
  readonly auth: RequestAuth;
  readonly assertions: readonly Assertion[];
  readonly captures: readonly Capture[];
  /** Saved test case (Test Plans) this request automates. */
  readonly testCaseId?: string;
  readonly timeoutMs?: number;
}

export interface ApiFolder {
  readonly id: string;
  readonly type: 'folder';
  readonly name: string;
  readonly description?: string;
  readonly auth?: RequestAuth;
  readonly items: readonly ApiItem[];
}

export type ApiItem = ApiRequestSpec | ApiFolder;

/** What a collection run needs; the stored collection adds ids, owner and timestamps. */
export interface CollectionSpec {
  readonly name: string;
  readonly description?: string;
  readonly variables: readonly Variable[];
  readonly auth: RequestAuth;
  readonly items: readonly ApiItem[];
}

export interface AssertionResult {
  readonly id: string;
  readonly label: string;
  readonly passed: boolean;
  readonly actual?: string;
}

export interface RequestResult {
  readonly requestId: string;
  readonly name: string;
  /** Folder names from the collection root, for grouping in reports. */
  readonly path: readonly string[];
  readonly method: HttpMethod;
  /** The URL as sent, with secret values masked. */
  readonly url: string;
  readonly status: number | null;
  readonly durationMs: number;
  readonly sizeBytes: number;
  /** No network error and every assertion passed. */
  readonly passed: boolean;
  readonly error?: string;
  readonly assertions: readonly AssertionResult[];
  readonly response?: {
    readonly headers: Readonly<Record<string, string>>;
    /** First bytes of the body, secrets masked. */
    readonly bodyPreview: string;
  };
}

export interface CollectionRunResult {
  readonly durationMs: number;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly results: readonly RequestResult[];
}

export const LOAD_PROFILE_TYPES = [
  'smoke',
  'load',
  'stress',
  'spike',
  'soak',
  'breakpoint',
  'custom',
] as const;
export type LoadProfileType = (typeof LOAD_PROFILE_TYPES)[number];

/** Like k6 ramping VUs: the VU count moves linearly to `targetVus` during `durationSec`. */
export interface LoadStage {
  readonly durationSec: number;
  readonly targetVus: number;
}

export const LOAD_METRICS = [
  'avg',
  'p50',
  'p90',
  'p95',
  'p99',
  'max',
  'errorRate',
  'rps',
  'checksRate',
] as const;
export type LoadMetric = (typeof LOAD_METRICS)[number];

export interface LoadThreshold {
  readonly metric: LoadMetric;
  readonly operator: 'lt' | 'lte' | 'gt' | 'gte';
  /** Milliseconds for latencies, a 0..1 ratio for rates, requests per second for rps. */
  readonly value: number;
  /** Stops the run as soon as the threshold fails (checked every second after 10 s). */
  readonly abortOnFail?: boolean;
}

export interface LoadPlan {
  readonly requests: readonly {
    readonly request: ApiRequestSpec;
    /** Effective auth, with `inherit` already resolved through folders and the collection. */
    readonly auth: RequestAuth;
    readonly weight: number;
  }[];
  readonly variables: readonly Variable[];
  readonly stages: readonly LoadStage[];
  /** Pause of each virtual user between two requests. */
  readonly thinkTimeMs: number;
  readonly thresholds: readonly LoadThreshold[];
  readonly timeoutMs?: number;
}

/** A run's frozen input, as the worker or `devkit runner` receives it. */
export type RunPayload =
  | {
      readonly kind: 'integration';
      readonly collection: CollectionSpec;
      readonly environment: readonly Variable[];
      readonly itemIds: readonly string[];
      readonly bail: boolean;
    }
  | {
      readonly kind: 'load';
      readonly plan: LoadPlan;
      /** Limit of the place where it runs (ADK workers or the user's computer). */
      readonly maxVus: number;
    };

export interface RunOutcome {
  readonly status: 'passed' | 'failed' | 'error';
  readonly result: CollectionRunResult | LoadSummary | null;
  readonly error: string | null;
}

export interface LoadTick {
  /** Seconds since the start. */
  readonly t: number;
  readonly vus: number;
  readonly requests: number;
  readonly errors: number;
  readonly avg: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface LatencySummary {
  readonly min: number;
  readonly avg: number;
  readonly p50: number;
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export interface ThresholdResult extends LoadThreshold {
  readonly actual: number;
  readonly passed: boolean;
}

export interface LoadSummary {
  readonly durationSec: number;
  readonly maxVus: number;
  readonly totalRequests: number;
  readonly failedRequests: number;
  readonly errorRate: number;
  readonly rps: number;
  readonly latency: LatencySummary;
  readonly checks: { readonly passed: number; readonly failed: number };
  readonly statusCodes: Readonly<Record<string, number>>;
  readonly errors: Readonly<Record<string, number>>;
  readonly perRequest: readonly {
    readonly requestId: string;
    readonly name: string;
    readonly count: number;
    readonly failed: number;
    readonly avg: number;
    readonly p95: number;
  }[];
  readonly thresholds: readonly ThresholdResult[];
  /** Every threshold passed (true when there are none). */
  readonly passed: boolean;
  /** Set when an `abortOnFail` threshold stopped the run early. */
  readonly abortedBy?: LoadMetric;
  readonly timeline: readonly LoadTick[];
}
