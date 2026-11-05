// Shared by the ADK workers and `devkit runner` (copied into apps/Cli/src/vendor/apitests by
// apps/Cli/scripts/sync-apitests-engine.mjs). Keep these files dependency-free: no imports from
// outside this folder, only Node built-ins.

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * What a request speaks. `http` and `graphql` go over HTTP; `grpc` over HTTP/2 (`grpc://` or
 * `grpcs://` URLs); `websocket` (`ws://`, `wss://`), `sse` (an HTTP event stream) and `socket`
 * (`tcp://`, `tls://`, `udp://`) exchange messages for a while and collect what comes back.
 */
export const REQUEST_KINDS = ['http', 'graphql', 'grpc', 'websocket', 'sse', 'socket'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

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

/** A file kept inside the collection (multipart fields, binary bodies). */
export interface FileValue {
  readonly fileName: string;
  readonly contentType?: string;
  /** Base64 content. */
  readonly data: string;
}

/** A multipart field: text, or a file when `type` is `file`. */
export interface FormField extends KeyValue {
  readonly type?: 'text' | 'file';
  readonly file?: FileValue;
  /** Content type of a text part (e.g. `application/json`). */
  readonly contentType?: string;
}

export type RequestBody =
  | { readonly mode: 'none' }
  | { readonly mode: 'json' | 'text' | 'xml' | 'sparql'; readonly content: string }
  | { readonly mode: 'urlencoded'; readonly fields: readonly KeyValue[] }
  /** multipart/form-data. */
  | { readonly mode: 'form'; readonly fields: readonly FormField[] }
  | { readonly mode: 'binary'; readonly file: FileValue | null };

export const OAUTH2_GRANTS = ['client_credentials', 'password', 'refresh_token'] as const;

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
    }
  /** RFC 7616: answers the server's 401 challenge (MD5, SHA-256, qop auth). */
  | { readonly type: 'digest'; readonly username: string; readonly password: string }
  /**
   * Gets an access token from `accessTokenUrl` once per run (and again when it expires), then
   * sends it like a bearer token.
   */
  | {
      readonly type: 'oauth2';
      readonly grantType: (typeof OAUTH2_GRANTS)[number];
      readonly accessTokenUrl: string;
      readonly clientId: string;
      readonly clientSecret: string;
      readonly username?: string;
      readonly password?: string;
      readonly refreshToken?: string;
      readonly scope?: string;
      readonly audience?: string;
      /** Client credentials in the token request body or as a Basic header. */
      readonly credentialsPlacement?: 'body' | 'basic';
      readonly tokenPlacement?: 'header' | 'query';
      /** Header prefix of the token; `Bearer` by default. */
      readonly tokenPrefix?: string;
      /** Query parameter name when `tokenPlacement` is `query`; `access_token` by default. */
      readonly tokenQueryKey?: string;
    }
  /** AWS Signature Version 4. */
  | {
      readonly type: 'awsv4';
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly sessionToken?: string;
      readonly service: string;
      readonly region: string;
    }
  /** OAuth 1.0a signed requests. */
  | {
      readonly type: 'oauth1';
      readonly consumerKey: string;
      readonly consumerSecret: string;
      readonly token?: string;
      readonly tokenSecret?: string;
      readonly signatureMethod: 'HMAC-SHA1' | 'HMAC-SHA256' | 'PLAINTEXT';
      readonly realm?: string;
      readonly addTo?: 'header' | 'query';
    }
  /** WS-Security UsernameToken (X-WSSE header). */
  | { readonly type: 'wsse'; readonly username: string; readonly password: string }
  /** Akamai EdgeGrid. */
  | {
      readonly type: 'edgegrid';
      readonly clientToken: string;
      readonly clientSecret: string;
      readonly accessToken: string;
      readonly headersToSign?: string;
      readonly maxBodySize?: number;
    };

export type AuthType = RequestAuth['type'];

/**
 * Credential fields of each auth type. Their values are personal: each workspace member keeps
 * their own (encrypted) and the shared collection only keeps `{{variable}}` references.
 */
export const AUTH_SECRET_FIELDS: Readonly<Record<AuthType, readonly string[]>> = {
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

/** Pre-request, post-response and test scripts: JavaScript calling the `adk` API. */
export interface Scripts {
  readonly preRequest?: string;
  readonly postResponse?: string;
  readonly tests?: string;
}

/**
 * Order of the scripts of the collection, folders and request. `sandwich` (Bruno's default):
 * pre-request from the collection down, post-response from the request up. `sequential`: both
 * from the collection down.
 */
export type ScriptFlow = 'sandwich' | 'sequential';

export interface ProxySettings {
  readonly enabled: boolean;
  readonly protocol: 'http' | 'https' | 'socks4' | 'socks5';
  readonly hostname: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  /** Comma separated hosts that skip the proxy; `*.example.com` matches subdomains. */
  readonly bypass?: string;
}

/** A client certificate (mTLS), used for the hosts that match `domain` (`*.example.com`). */
export interface ClientCertificate {
  readonly domain: string;
  readonly type: 'pem' | 'pfx';
  /** PEM certificate chain. */
  readonly cert?: string;
  /** PEM private key. */
  readonly key?: string;
  /** Base64 PKCS#12 file. */
  readonly pfx?: string;
  readonly passphrase?: string;
}

export interface TlsSettings {
  /** Verify the server certificate (on by default). */
  readonly verify?: boolean;
  /** Extra trusted CA certificates, PEM. */
  readonly caCertificate?: string;
}

export interface ProtoFile {
  /** Path as imports refer to it, e.g. `orders/v1/orders.proto`. */
  readonly name: string;
  readonly content: string;
}

/** Collection-wide network and run settings. */
export interface CollectionSettings {
  readonly proxy?: ProxySettings;
  readonly tls?: TlsSettings;
  readonly clientCertificates?: readonly ClientCertificate[];
  readonly followRedirects?: boolean;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
  /** Keep cookies between the requests of a run (and between sends, per user). On by default. */
  readonly cookies?: boolean;
  /** Defaults for new requests. */
  readonly presets?: { readonly kind?: RequestKind; readonly baseUrl?: string };
}

export interface RequestSettings {
  readonly followRedirects?: boolean;
  readonly maxRedirects?: number;
  /** Percent-encode the URL as typed (on by default). */
  readonly encodeUrl?: boolean;
}

export interface GraphqlSpec {
  readonly query: string;
  /** JSON object text. */
  readonly variables?: string;
  readonly operationName?: string;
}

export interface GrpcSpec {
  /** Full method name: `package.Service/Method`. */
  readonly method: string;
  /** Proto file of the collection that defines it; reflection is used when absent. */
  readonly protoFile?: string;
  /** Ask the server (gRPC server reflection) instead of the proto files. */
  readonly reflection?: boolean;
  /**
   * Request message as JSON. For client and bidirectional streaming, a JSON array of messages
   * (each one is sent in order).
   */
  readonly message: string;
}

export interface OutgoingMessage {
  readonly name?: string;
  readonly content: string;
  /** websocket: text, json or binary (base64); socket: text, hex or base64. */
  readonly type?: 'text' | 'json' | 'binary' | 'hex' | 'base64';
  /** Pause before sending this message. */
  readonly delayMs?: number;
}

export interface WebSocketSpec {
  readonly messages: readonly OutgoingMessage[];
  readonly subprotocols?: readonly string[];
  /** How long to listen after the last message is sent; 2 s by default. */
  readonly listenMs?: number;
  /** Close as soon as this many messages arrived. */
  readonly maxMessages?: number;
}

export interface SseSpec {
  /** How long to listen; 5 s by default. */
  readonly listenMs?: number;
  readonly maxEvents?: number;
}

export interface SocketSpec {
  readonly messages: readonly OutgoingMessage[];
  /** How long to listen after the last message is sent; 2 s by default. */
  readonly listenMs?: number;
  /** Stop reading once the received text contains this. */
  readonly readUntil?: string;
  /** How received bytes are shown and asserted. */
  readonly responseEncoding?: 'text' | 'hex' | 'base64';
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
  /** `http` when absent. */
  readonly kind?: RequestKind;
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
  /** Request variables, resolved before the pre-request scripts. */
  readonly vars?: readonly KeyValue[];
  readonly scripts?: Scripts;
  readonly settings?: RequestSettings;
  readonly tags?: readonly string[];
  readonly graphql?: GraphqlSpec;
  readonly grpc?: GrpcSpec;
  readonly websocket?: WebSocketSpec;
  readonly sse?: SseSpec;
  readonly socket?: SocketSpec;
}

export interface ApiFolder {
  readonly id: string;
  readonly type: 'folder';
  readonly name: string;
  readonly description?: string;
  readonly auth?: RequestAuth;
  /** Sent with every request inside the folder (the request's own headers win). */
  readonly headers?: readonly KeyValue[];
  readonly vars?: readonly KeyValue[];
  readonly scripts?: Scripts;
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
  /** Sent with every request (folders and requests override them by name). */
  readonly headers?: readonly KeyValue[];
  readonly scripts?: Scripts;
  readonly scriptFlow?: ScriptFlow;
  readonly settings?: CollectionSettings;
  /** .proto sources for gRPC requests. */
  readonly protoFiles?: readonly ProtoFile[];
}

export interface AssertionResult {
  readonly id: string;
  readonly label: string;
  readonly passed: boolean;
  readonly actual?: string;
}

/** One message of a streaming exchange (WebSocket, SSE, socket, gRPC stream). */
export interface StreamMessage {
  readonly direction: 'sent' | 'received' | 'info';
  /** Milliseconds since the exchange started. */
  readonly at: number;
  readonly data: string;
  readonly type?: 'text' | 'json' | 'binary' | 'event';
  /** SSE event name. */
  readonly event?: string;
}

export interface ScriptLog {
  readonly level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  readonly message: string;
  /** Which script wrote it, e.g. `collection pre-request`. */
  readonly source: string;
}

/** How the request went over the network, as the Timeline tab shows it. */
export interface RequestTimeline {
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    /** First bytes of the body sent, secrets masked. */
    readonly bodyPreview?: string;
  };
  readonly httpVersion?: string;
  readonly remoteAddress?: string;
  readonly redirects?: readonly { readonly status: number; readonly url: string }[];
  /** Milliseconds of each phase (absent when not measured, e.g. a reused connection). */
  readonly timings?: {
    readonly dns?: number;
    readonly connect?: number;
    readonly tls?: number;
    readonly firstByte?: number;
    readonly download?: number;
    readonly total: number;
  };
}

export interface RequestResult {
  readonly requestId: string;
  readonly name: string;
  /** `http` when absent. */
  readonly kind?: RequestKind;
  /** Folder names from the collection root, for grouping in reports. */
  readonly path: readonly string[];
  /** Iteration of a data-driven run, from 1. */
  readonly iteration?: number;
  /** A script skipped it (`adk.runner.skipRequest()`). */
  readonly skipped?: boolean;
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
  /** `test()` results of the scripts. */
  readonly tests?: readonly AssertionResult[];
  /** console output of the scripts, secrets masked. */
  readonly logs?: readonly ScriptLog[];
  readonly response?: {
    readonly headers: Readonly<Record<string, string>>;
    /** First bytes of the body, secrets masked. */
    readonly bodyPreview: string;
    /** The body was longer than the preview. */
    readonly truncated?: boolean;
    readonly statusText?: string;
    /** gRPC trailers. */
    readonly trailers?: Readonly<Record<string, string>>;
    /** Messages of a streaming exchange. */
    readonly messages?: readonly StreamMessage[];
  };
  readonly timeline?: RequestTimeline;
}

export interface CollectionRunResult {
  readonly durationMs: number;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  /** Requests skipped by scripts. */
  readonly skipped?: number;
  /** Iterations of a data-driven run. */
  readonly iterations?: number;
  readonly results: readonly RequestResult[];
}

export interface Cookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  /** Epoch milliseconds; session cookie when absent. */
  readonly expires?: number;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  /** Only sent to `domain` itself, not to its subdomains. */
  readonly hostOnly?: boolean;
  readonly sameSite?: string;
}

/**
 * What a run leaves for the next sends of the same user: variables set by captures and scripts,
 * and the cookie jar. Personal: never stored in the run, never shown to other members.
 */
export interface RuntimeState {
  readonly variables: readonly Variable[];
  readonly cookies: readonly Cookie[];
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
    /** Headers of the collection and the request's folders. */
    readonly inheritedHeaders?: readonly KeyValue[];
  }[];
  /** Network settings of the collection (proxy, TLS, certificates, redirects). */
  readonly settings?: CollectionSettings;
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
      readonly environmentName?: string;
      readonly itemIds: readonly string[];
      readonly bail: boolean;
      /**
       * `run` executes the requests; `grpc-reflect` lists the services and methods of the
       * selected gRPC request (its result body is a {@link GrpcServiceList} as JSON).
       */
      readonly mode?: 'run' | 'grpc-reflect';
      /** The requesting user's runtime variables and cookies from previous sends. */
      readonly runtime?: RuntimeState;
      /** Runs the selection this many times (data rows win when given). */
      readonly iterations?: number;
      /** Data-driven run: one iteration per row, the row's columns as variables. */
      readonly data?: readonly Readonly<Record<string, string>>[];
      /** Pause between requests. */
      readonly delayMs?: number;
      /** Bytes of each response body kept in the result; 4 KB by default. */
      readonly previewBytes?: number;
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
  /** Integration runs: the runtime state to keep for the requesting user. */
  readonly runtime?: RuntimeState;
}

/** Services of a gRPC server or of the collection's proto files. */
export interface GrpcServiceList {
  readonly services: readonly {
    readonly name: string;
    readonly methods: readonly {
      readonly name: string;
      /** `package.Service/Method`. */
      readonly path: string;
      readonly requestType: string;
      readonly responseType: string;
      readonly clientStreaming: boolean;
      readonly serverStreaming: boolean;
      /** A request message with every field set to an example value. */
      readonly example: unknown;
    }[];
  }[];
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
