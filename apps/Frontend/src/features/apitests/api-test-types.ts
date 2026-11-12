import { getMessages } from '../../lib/i18n/index.js';

// Integration tests (collections) and overload tests (load scenarios), as the ADK API returns
// them. The shapes follow apps/Backend/src/modules/apitests.

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** What a request speaks; `http` when absent. See apps/Backend/.../engine/types.ts. */
export const REQUEST_KINDS = ['http', 'graphql', 'grpc', 'websocket', 'sse', 'socket'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export interface KeyValue {
  key: string;
  value: string;
  enabled?: boolean;
}

export interface Variable extends KeyValue {
  /** Personal: each member keeps their own value; the shared collection never holds it. */
  secret?: boolean;
  /** Returned by the API for secrets: whether the current user has set their own value. */
  hasValue?: boolean;
}

export interface FileValue {
  fileName: string;
  contentType?: string;
  /** Base64 content. */
  data: string;
}

export interface FormField extends KeyValue {
  type?: 'text' | 'file';
  file?: FileValue;
  contentType?: string;
}

export type RequestBody =
  | { mode: 'none' }
  | { mode: 'json' | 'text' | 'xml' | 'sparql'; content: string }
  | { mode: 'urlencoded'; fields: KeyValue[] }
  | { mode: 'form'; fields: FormField[] }
  | { mode: 'binary'; file: FileValue | null };

export const OAUTH2_GRANTS = ['client_credentials', 'password', 'refresh_token'] as const;

export type RequestAuth =
  | { type: 'none' }
  | { type: 'inherit' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apikey'; key: string; value: string; in: 'header' | 'query' }
  | { type: 'digest'; username: string; password: string }
  | {
      type: 'oauth2';
      grantType: (typeof OAUTH2_GRANTS)[number];
      accessTokenUrl: string;
      clientId: string;
      clientSecret: string;
      username?: string;
      password?: string;
      refreshToken?: string;
      scope?: string;
      audience?: string;
      credentialsPlacement?: 'body' | 'basic';
      tokenPlacement?: 'header' | 'query';
      tokenPrefix?: string;
      tokenQueryKey?: string;
    }
  | {
      type: 'awsv4';
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
      service: string;
      region: string;
    }
  | {
      type: 'oauth1';
      consumerKey: string;
      consumerSecret: string;
      token?: string;
      tokenSecret?: string;
      signatureMethod: 'HMAC-SHA1' | 'HMAC-SHA256' | 'PLAINTEXT';
      realm?: string;
      addTo?: 'header' | 'query';
    }
  | { type: 'wsse'; username: string; password: string }
  | {
      type: 'edgegrid';
      clientToken: string;
      clientSecret: string;
      accessToken: string;
      headersToSign?: string;
      maxBodySize?: number;
    };

export type AuthType = RequestAuth['type'];

/**
 * Credential fields of each auth type: personal per member. A literal value typed there is kept
 * in the member's own vault; a `{{variable}}` reference stays in the shared collection.
 */
export const AUTH_SECRET_FIELDS: Record<AuthType, readonly string[]> = {
  none: [],
  inherit: [],
  bearer: ['token'],
  basic: ['username', 'password'],
  apikey: ['value'],
  digest: ['username', 'password'],
  oauth2: ['clientId', 'clientSecret', 'username', 'password', 'refreshToken'],
  awsv4: ['accessKeyId', 'secretAccessKey', 'sessionToken'],
  oauth1: ['consumerKey', 'consumerSecret', 'token', 'tokenSecret'],
  wsse: ['username', 'password'],
  edgegrid: ['clientToken', 'clientSecret', 'accessToken'],
};

export interface Scripts {
  preRequest?: string;
  postResponse?: string;
  tests?: string;
}

export type ScriptFlow = 'sandwich' | 'sequential';

export interface ProxySettings {
  enabled: boolean;
  protocol: 'http' | 'https' | 'socks4' | 'socks5';
  hostname: string;
  port: number;
  username?: string;
  password?: string;
  bypass?: string;
}

export interface ClientCertificate {
  domain: string;
  type: 'pem' | 'pfx';
  cert?: string;
  key?: string;
  pfx?: string;
  passphrase?: string;
}

export interface CollectionSettings {
  proxy?: ProxySettings;
  tls?: { verify?: boolean; caCertificate?: string };
  clientCertificates?: ClientCertificate[];
  followRedirects?: boolean;
  maxRedirects?: number;
  timeoutMs?: number;
  cookies?: boolean;
  presets?: { kind?: RequestKind; baseUrl?: string };
}

export interface RequestSettings {
  followRedirects?: boolean;
  maxRedirects?: number;
  encodeUrl?: boolean;
}

export interface ProtoFile {
  name: string;
  content: string;
}

export interface GraphqlSpec {
  query: string;
  variables?: string;
  operationName?: string;
}

export interface GrpcSpec {
  /** `package.Service/Method`. */
  method: string;
  protoFile?: string;
  reflection?: boolean;
  /** JSON; a JSON array of messages for client and bidirectional streaming. */
  message: string;
}

export interface OutgoingMessage {
  name?: string;
  content: string;
  type?: 'text' | 'json' | 'binary' | 'hex' | 'base64';
  delayMs?: number;
}

export interface WebSocketSpec {
  messages: OutgoingMessage[];
  subprotocols?: string[];
  listenMs?: number;
  maxMessages?: number;
}

export interface SseSpec {
  listenMs?: number;
  maxEvents?: number;
}

export interface SocketSpec {
  messages: OutgoingMessage[];
  listenMs?: number;
  readUntil?: string;
  responseEncoding?: 'text' | 'hex' | 'base64';
}

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
  /** `http` when absent. */
  kind?: RequestKind;
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
  vars?: KeyValue[];
  scripts?: Scripts;
  settings?: RequestSettings;
  tags?: string[];
  graphql?: GraphqlSpec;
  grpc?: GrpcSpec;
  websocket?: WebSocketSpec;
  sse?: SseSpec;
  socket?: SocketSpec;
}

export interface ApiFolder {
  id: string;
  type: 'folder';
  name: string;
  description?: string;
  auth?: RequestAuth;
  headers?: KeyValue[];
  vars?: KeyValue[];
  scripts?: Scripts;
  items: ApiItem[];
}

export type ApiItem = ApiRequestSpec | ApiFolder;

/** Tools whose command-line runner the generated pipeline uses. */
export const CI_TOOLS = ['bruno', 'postman', 'insomnia'] as const;
export type CiTool = (typeof CI_TOOLS)[number];

/** Where the collection lives in the team's repository and how its pipeline runs it. */
export interface CiConfig {
  repository: {
    provider: 'github' | 'azure_devops';
    id: string;
    name: string;
    branch: string;
    /** Folder inside the repository, without leading or trailing slashes. */
    path: string;
  };
  tool: CiTool;
  environmentId?: string | null;
}

/** Secret the pipeline reads a secret variable from. */
export interface CiSecret {
  variable: string;
  name: string;
}

/** The files a pipeline generation would commit (secrets exported empty). */
export interface CiPreview {
  files: { path: string; content: string }[];
  pipelinePath: string;
  secrets: CiSecret[];
}

export interface CiPublication {
  /** Null when the repository already had these files. */
  commitUrl: string | null;
  pipelinePath: string;
  files: string[];
  removed: string[];
  secrets: CiSecret[];
}

export interface ApiCollection {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  variables: Variable[];
  auth: RequestAuth;
  items: ApiItem[];
  headers?: KeyValue[];
  scripts?: Scripts;
  scriptFlow?: ScriptFlow;
  settings?: CollectionSettings;
  protoFiles?: ProtoFile[];
  ci?: CiConfig;
  source: { kind: string; detail?: string };
  updatedAt: string;
  /**
   * Refs of the personal secrets the current user has set in this collection (see
   * `secretRef`): `var:<key>`, `auth:<collection|itemId>:<field>`, `proxy:<field>`,
   * `cert:<index>:<field>`.
   */
  personalSecrets?: string[];
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
  /** Refs (`var:<key>`) of the personal secrets the current user has set here. */
  personalSecrets?: string[];
}

/** Ref of a personal secret, as the API lists it in `personalSecrets`. */
export const secretRef = {
  variable: (key: string) => `var:${key}`,
  /** `owner` is `collection` or the id of the folder or request. */
  auth: (owner: string, field: string) => `auth:${owner}:${field}`,
  proxy: (field: 'username' | 'password') => `proxy:${field}`,
  certificate: (index: number, field: 'key' | 'pfx' | 'passphrase') => `cert:${index}:${field}`,
};

/** A value that is only `{{variable}}` references stays shared; anything else is personal. */
export const isVariableReference = (value: string) =>
  /^\s*(\{\{\s*[$\w.-]+\s*\}\}\s*)+$/.test(value);

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  secure?: boolean;
  httpOnly?: boolean;
  hostOnly?: boolean;
  sameSite?: string;
}

/** The current user's runtime variables and cookies of a collection (never shared). */
export interface RuntimeState {
  variables: Variable[];
  cookies: Cookie[];
}

export interface GrpcMethodInfo {
  name: string;
  path: string;
  requestType: string;
  responseType: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
  example: unknown;
}

export interface GrpcServiceList {
  services: { name: string; methods: GrpcMethodInfo[] }[];
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

export interface StreamMessage {
  direction: 'sent' | 'received' | 'info';
  at: number;
  data: string;
  type?: 'text' | 'json' | 'binary' | 'event';
  event?: string;
}

export interface ScriptLog {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source: string;
}

export interface RequestTimeline {
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    bodyPreview?: string;
  };
  httpVersion?: string;
  remoteAddress?: string;
  redirects?: { status: number; url: string }[];
  timings?: {
    dns?: number;
    connect?: number;
    tls?: number;
    firstByte?: number;
    download?: number;
    total: number;
  };
}

export interface RequestResult {
  requestId: string;
  name: string;
  kind?: RequestKind;
  path: string[];
  iteration?: number;
  skipped?: boolean;
  method: HttpMethod;
  url: string;
  status: number | null;
  durationMs: number;
  sizeBytes: number;
  passed: boolean;
  error?: string;
  assertions: AssertionResult[];
  tests?: AssertionResult[];
  logs?: ScriptLog[];
  response?: {
    headers: Record<string, string>;
    bodyPreview: string;
    truncated?: boolean;
    statusText?: string;
    trailers?: Record<string, string>;
    messages?: StreamMessage[];
  };
  timeline?: RequestTimeline;
}

export interface CollectionRunResult {
  durationMs: number;
  total: number;
  passed: number;
  failed: number;
  skipped?: number;
  iterations?: number;
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

/** A new request of the given kind, with the defaults of its protocol. */
export function newRequest(
  name = getMessages().apiTests.newRequestName,
  kind: RequestKind = 'http',
  baseUrl = '{{baseUrl}}',
): ApiRequestSpec {
  const base: ApiRequestSpec = {
    id: crypto.randomUUID(),
    type: 'request',
    name,
    method: 'GET',
    url: `${baseUrl}/`,
    headers: [],
    query: [],
    body: { mode: 'none' },
    auth: { type: 'inherit' },
    assertions: [{ id: crypto.randomUUID(), source: 'status', operator: 'eq', expected: '200' }],
    captures: [],
  };
  switch (kind) {
    case 'graphql':
      return {
        ...base,
        kind,
        method: 'POST',
        url: `${baseUrl}/graphql`,
        graphql: { query: 'query {\n  \n}', variables: '{}' },
        assertions: [
          ...base.assertions,
          { id: crypto.randomUUID(), source: 'json', path: 'errors', operator: 'notExists' },
        ],
      };
    case 'grpc':
      return {
        ...base,
        kind,
        method: 'POST',
        url: 'grpc://localhost:50051',
        grpc: { method: '', reflection: true, message: '{}' },
        // gRPC status 0 is OK.
        assertions: [{ id: crypto.randomUUID(), source: 'status', operator: 'eq', expected: '0' }],
      };
    case 'websocket':
      return {
        ...base,
        kind,
        url: 'wss://',
        websocket: { messages: [{ content: '', type: 'text' }], listenMs: 2_000 },
        assertions: [
          { id: crypto.randomUUID(), source: 'status', operator: 'eq', expected: '101' },
        ],
      };
    case 'sse':
      return {
        ...base,
        kind,
        url: `${baseUrl}/events`,
        headers: [{ key: 'Accept', value: 'text/event-stream' }],
        sse: { listenMs: 5_000 },
      };
    case 'socket':
      return {
        ...base,
        kind,
        url: 'tcp://localhost:9000',
        socket: { messages: [{ content: '', type: 'text' }], listenMs: 2_000 },
        // A socket that connected has status 0.
        assertions: [{ id: crypto.randomUUID(), source: 'status', operator: 'eq', expected: '0' }],
      };
    default:
      return base;
  }
}
