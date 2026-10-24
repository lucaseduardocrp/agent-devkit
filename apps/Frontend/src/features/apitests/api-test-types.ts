// Integration tests (collections) and overload tests (load scenarios), as the ADK API returns
// them. The shapes follow apps/Backend/src/modules/apitests.

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface KeyValue {
  key: string;
  value: string;
  enabled?: boolean;
}

export interface Variable extends KeyValue {
  secret?: boolean;
  /** Returned by the API for secrets: their value is never sent back. */
  hasValue?: boolean;
}

export type RequestBody =
  | { mode: 'none' }
  | { mode: 'json' | 'text' | 'xml'; content: string }
  | { mode: 'form' | 'urlencoded'; fields: KeyValue[] };

export type RequestAuth =
  | { type: 'none' }
  | { type: 'inherit' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apikey'; key: string; value: string; in: 'header' | 'query' };

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
  id: string;
  source: (typeof ASSERTION_SOURCES)[number];
  path?: string;
  operator: (typeof ASSERTION_OPERATORS)[number];
  expected?: string;
}

export interface Capture {
  variable: string;
  source: 'json' | 'header' | 'status' | 'body';
  path?: string;
}

export interface ApiRequestSpec {
  id: string;
  type: 'request';
  name: string;
  description?: string;
  method: HttpMethod;
  url: string;
  /** Values of the `:name` segments of the URL path. */
  pathParams?: KeyValue[];
  headers: KeyValue[];
  query: KeyValue[];
  body: RequestBody;
  auth: RequestAuth;
  assertions: Assertion[];
  captures: Capture[];
  testCaseId?: string;
  timeoutMs?: number;
}

export interface ApiFolder {
  id: string;
  type: 'folder';
  name: string;
  description?: string;
  auth?: RequestAuth;
  items: ApiItem[];
}

export type ApiItem = ApiRequestSpec | ApiFolder;

export interface ApiCollection {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  variables: Variable[];
  auth: RequestAuth;
  items: ApiItem[];
  source: { kind: string; detail?: string };
  updatedAt: string;
}

export interface ApiCollectionSummary {
  id: string;
  name: string;
  description: string;
  source: { kind: string; detail?: string };
  requestCount: number;
  updatedAt: string;
}

export interface ApiEnvironment {
  id: string;
  name: string;
  variables: Variable[];
}

export const MOCK_GROUPS = [
  'ids',
  'person',
  'address',
  'contact',
  'company',
  'finance',
  'numbers',
  'dates',
  'internet',
  'text',
  'documents',
] as const;
export type MockGroup = (typeof MOCK_GROUPS)[number];

/** A mock value requests can use as `{{name}}` (`{{$randomFullName}}`), with a sample of it. */
export interface ApiMockValue {
  name: string;
  group: MockGroup;
  sample: string;
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

export interface LoadStage {
  durationSec: number;
  targetVus: number;
}

export interface LoadThreshold {
  metric: LoadMetric;
  operator: 'lt' | 'lte' | 'gt' | 'gte';
  value: number;
  abortOnFail?: boolean;
}

export interface LoadScenarioInput {
  name: string;
  description?: string;
  collectionId: string;
  environmentId?: string | null;
  requests: { requestId: string; weight: number }[];
  profile: LoadProfileType;
  stages: LoadStage[];
  thinkTimeMs: number;
  thresholds: LoadThreshold[];
  timeoutMs?: number;
}

export interface LoadScenario extends LoadScenarioInput {
  id: string;
  updatedAt: string;
}

export interface LoadProfileDefaults {
  profile: LoadProfileType;
  stages: LoadStage[];
  thresholds: LoadThreshold[];
}

export interface AssertionResult {
  id: string;
  label: string;
  passed: boolean;
  actual?: string;
}

export interface RequestResult {
  requestId: string;
  name: string;
  path: string[];
  method: HttpMethod;
  url: string;
  status: number | null;
  durationMs: number;
  sizeBytes: number;
  passed: boolean;
  error?: string;
  assertions: AssertionResult[];
  response?: { headers: Record<string, string>; bodyPreview: string };
}

export interface CollectionRunResult {
  durationMs: number;
  total: number;
  passed: number;
  failed: number;
  results?: RequestResult[];
}

export interface LoadTick {
  t: number;
  vus: number;
  requests: number;
  errors: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface LoadSummary {
  durationSec: number;
  maxVus: number;
  totalRequests: number;
  failedRequests: number;
  errorRate: number;
  rps: number;
  latency: {
    min: number;
    avg: number;
    p50: number;
    p90: number;
    p95: number;
    p99: number;
    max: number;
  };
  checks: { passed: number; failed: number };
  statusCodes: Record<string, number>;
  errors: Record<string, number>;
  perRequest?: {
    requestId: string;
    name: string;
    count: number;
    failed: number;
    avg: number;
    p95: number;
  }[];
  thresholds: (LoadThreshold & { actual: number; passed: boolean })[];
  passed: boolean;
  abortedBy?: LoadMetric;
  timeline?: LoadTick[];
}

export type ApiRunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'cancelled';
export type ApiRunTarget = 'remote' | 'local';

export interface ApiRun<R = CollectionRunResult | LoadSummary> {
  id: string;
  kind: 'integration' | 'load';
  collectionId: string;
  scenarioId: string | null;
  environmentId: string | null;
  name: string;
  target: ApiRunTarget;
  status: ApiRunStatus;
  claimLabel: string | null;
  result: R | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export const isActiveRun = (run: Pick<ApiRun, 'status'>) =>
  run.status === 'queued' || run.status === 'running';

export type SourceType = 'testPlan' | 'testSuite' | 'brain' | 'spec' | 'pbi';

export interface GenerationRequest {
  sources: { type: SourceType; id: string }[];
  instructions?: string;
  baseUrl?: string;
  collectionId?: string;
}

export type ExportFormat = 'adk' | 'postman' | 'insomnia' | 'bruno';

/** Every request in order, with its folder names. */
export function flattenItems(
  items: readonly ApiItem[],
  path: string[] = [],
): { request: ApiRequestSpec; path: string[] }[] {
  return items.flatMap((item) =>
    item.type === 'folder'
      ? flattenItems(item.items, [...path, item.name])
      : [{ request: item, path }],
  );
}

export function newRequest(name = 'New request'): ApiRequestSpec {
  return {
    id: crypto.randomUUID(),
    type: 'request',
    name,
    method: 'GET',
    url: '{{baseUrl}}/',
    headers: [],
    query: [],
    body: { mode: 'none' },
    auth: { type: 'inherit' },
    assertions: [{ id: crypto.randomUUID(), source: 'status', operator: 'eq', expected: '200' }],
    captures: [],
  };
}
