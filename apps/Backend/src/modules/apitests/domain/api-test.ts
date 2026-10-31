import { z } from 'zod';
import {
  ASSERTION_OPERATORS,
  ASSERTION_SOURCES,
  HTTP_METHODS,
  LOAD_METRICS,
  LOAD_PROFILE_TYPES,
  OAUTH2_GRANTS,
  REQUEST_KINDS,
  type ApiItem,
  type CollectionRunResult,
  type LoadProfileType,
  type LoadStage,
  type LoadSummary,
  type LoadThreshold,
  type RequestAuth,
  type RunPayload,
  type Variable,
} from '../engine/types.js';

// Integration tests (collections of requests with assertions) and load tests (scenarios that
// replay some of those requests under load). Both run on the ADK workers or on the requesting
// user's computer through `devkit runner`.

export const LIMITS = {
  itemsPerCollection: 500,
  depth: 8,
  bodyChars: 200_000,
  scriptChars: 100_000,
  /** Base64 characters of one file (multipart field, binary body): about 3 MB. */
  fileChars: 4_000_000,
  protoChars: 500_000,
  /** Rows of a data-driven run and iterations of a run. */
  dataRows: 1_000,
  /** Virtual users and length of a load run on the ADK workers. */
  remote: { vus: 200, durationSec: 15 * 60 },
  /** On the user's computer, where the user pays for the load. */
  local: { vus: 2_000, durationSec: 4 * 60 * 60 },
} as const;

const id = z.string().trim().min(1).max(100);
const text = (max: number) => z.string().max(max);
const keyValue = z.object({
  key: text(500),
  value: text(20_000),
  enabled: z.boolean().optional(),
});
export const variableSchema = keyValue.extend({ secret: z.boolean().optional() });

const secret = text(20_000);
const optionalSecret = secret.optional();

export const authSchema: z.ZodType<RequestAuth> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('inherit') }),
  z.object({ type: z.literal('bearer'), token: secret }),
  z.object({ type: z.literal('basic'), username: text(1_000), password: text(1_000) }),
  z.object({
    type: z.literal('apikey'),
    key: text(500),
    value: secret,
    in: z.enum(['header', 'query']),
  }),
  z.object({ type: z.literal('digest'), username: text(1_000), password: text(1_000) }),
  z.object({
    type: z.literal('oauth2'),
    grantType: z.enum(OAUTH2_GRANTS),
    accessTokenUrl: text(4_000),
    clientId: text(1_000),
    clientSecret: secret,
    username: text(1_000).optional(),
    password: optionalSecret,
    refreshToken: optionalSecret,
    scope: text(2_000).optional(),
    audience: text(2_000).optional(),
    credentialsPlacement: z.enum(['body', 'basic']).optional(),
    tokenPlacement: z.enum(['header', 'query']).optional(),
    tokenPrefix: text(100).optional(),
    tokenQueryKey: text(200).optional(),
  }),
  z.object({
    type: z.literal('awsv4'),
    accessKeyId: text(1_000),
    secretAccessKey: secret,
    sessionToken: optionalSecret,
    service: text(200),
    region: text(100),
  }),
  z.object({
    type: z.literal('oauth1'),
    consumerKey: text(1_000),
    consumerSecret: secret,
    token: optionalSecret,
    tokenSecret: optionalSecret,
    signatureMethod: z.enum(['HMAC-SHA1', 'HMAC-SHA256', 'PLAINTEXT']),
    realm: text(500).optional(),
    addTo: z.enum(['header', 'query']).optional(),
  }),
  z.object({ type: z.literal('wsse'), username: text(1_000), password: text(1_000) }),
  z.object({
    type: z.literal('edgegrid'),
    clientToken: secret,
    clientSecret: secret,
    accessToken: secret,
    headersToSign: text(2_000).optional(),
    maxBodySize: z.number().int().min(0).max(10_000_000).optional(),
  }),
]);

const fileSchema = z.object({
  fileName: z.string().trim().min(1).max(300),
  contentType: text(200).optional(),
  data: z.string().max(LIMITS.fileChars),
});

const formFieldSchema = keyValue.extend({
  type: z.enum(['text', 'file']).optional(),
  file: fileSchema.optional(),
  contentType: text(200).optional(),
});

const bodySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.enum(['json', 'text', 'xml', 'sparql']), content: text(LIMITS.bodyChars) }),
  z.object({ mode: z.literal('urlencoded'), fields: z.array(keyValue).max(200) }),
  z.object({ mode: z.literal('form'), fields: z.array(formFieldSchema).max(200) }),
  z.object({ mode: z.literal('binary'), file: fileSchema.nullable() }),
]);

const scriptsSchema = z.object({
  preRequest: text(LIMITS.scriptChars).optional(),
  postResponse: text(LIMITS.scriptChars).optional(),
  tests: text(LIMITS.scriptChars).optional(),
});

const outgoingMessageSchema = z.object({
  name: text(200).optional(),
  content: text(LIMITS.bodyChars),
  type: z.enum(['text', 'json', 'binary', 'hex', 'base64']).optional(),
  delayMs: z.number().int().min(0).max(60_000).optional(),
});

const listenMs = z.number().int().min(0).max(120_000).optional();

const requestSettingsSchema = z.object({
  followRedirects: z.boolean().optional(),
  maxRedirects: z.number().int().min(0).max(50).optional(),
  encodeUrl: z.boolean().optional(),
});

export const collectionSettingsSchema = z.object({
  proxy: z
    .object({
      enabled: z.boolean(),
      protocol: z.enum(['http', 'https', 'socks4', 'socks5']),
      hostname: text(500),
      port: z.number().int().min(0).max(65_535),
      username: text(1_000).optional(),
      password: optionalSecret,
      bypass: text(4_000).optional(),
    })
    .optional(),
  tls: z
    .object({ verify: z.boolean().optional(), caCertificate: text(200_000).optional() })
    .optional(),
  clientCertificates: z
    .array(
      z.object({
        domain: z.string().trim().min(1).max(500),
        type: z.enum(['pem', 'pfx']),
        cert: text(200_000).optional(),
        key: text(200_000).optional(),
        pfx: text(400_000).optional(),
        passphrase: optionalSecret,
      }),
    )
    .max(20)
    .optional(),
  followRedirects: z.boolean().optional(),
  maxRedirects: z.number().int().min(0).max(50).optional(),
  timeoutMs: z.number().int().min(100).max(300_000).optional(),
  cookies: z.boolean().optional(),
  presets: z
    .object({ kind: z.enum(REQUEST_KINDS).optional(), baseUrl: text(4_000).optional() })
    .optional(),
});

const assertionSchema = z.object({
  id,
  source: z.enum(ASSERTION_SOURCES),
  path: text(500).optional(),
  operator: z.enum(ASSERTION_OPERATORS),
  expected: text(5_000).optional(),
});

const captureSchema = z.object({
  variable: z.string().trim().min(1).max(200),
  source: z.enum(['json', 'header', 'status', 'body']),
  path: text(500).optional(),
});

export const requestSchema = z.object({
  id,
  type: z.literal('request'),
  name: z.string().trim().min(1).max(300),
  description: text(20_000).optional(),
  method: z.enum(HTTP_METHODS),
  url: z.string().trim().min(1).max(4_000),
  pathParams: z.array(keyValue).max(50).optional(),
  headers: z.array(keyValue).max(100).default([]),
  query: z.array(keyValue).max(100).default([]),
  body: bodySchema.default({ mode: 'none' }),
  auth: authSchema.default({ type: 'inherit' }),
  assertions: z.array(assertionSchema).max(100).default([]),
  captures: z.array(captureSchema).max(50).default([]),
  /** Saved test case this request automates, when it came from Test Plans. */
  testCaseId: z.string().max(200).optional(),
  timeoutMs: z.number().int().min(100).max(300_000).optional(),
  kind: z.enum(REQUEST_KINDS).optional(),
  vars: z.array(keyValue).max(100).optional(),
  scripts: scriptsSchema.optional(),
  settings: requestSettingsSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  graphql: z
    .object({
      query: text(LIMITS.bodyChars),
      variables: text(LIMITS.bodyChars).optional(),
      operationName: text(300).optional(),
    })
    .optional(),
  grpc: z
    .object({
      method: text(500),
      protoFile: text(500).optional(),
      reflection: z.boolean().optional(),
      message: text(LIMITS.bodyChars),
    })
    .optional(),
  websocket: z
    .object({
      messages: z.array(outgoingMessageSchema).max(100),
      subprotocols: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
      listenMs,
      maxMessages: z.number().int().min(1).max(10_000).optional(),
    })
    .optional(),
  sse: z.object({ listenMs, maxEvents: z.number().int().min(1).max(10_000).optional() }).optional(),
  socket: z
    .object({
      messages: z.array(outgoingMessageSchema).max(100),
      listenMs,
      readUntil: text(1_000).optional(),
      responseEncoding: z.enum(['text', 'hex', 'base64']).optional(),
    })
    .optional(),
});

export const itemSchema: z.ZodType<ApiItem> = z.lazy(() =>
  z.union([
    requestSchema,
    z.object({
      id,
      type: z.literal('folder'),
      name: z.string().trim().min(1).max(300),
      description: text(20_000).optional(),
      auth: authSchema.optional(),
      headers: z.array(keyValue).max(100).optional(),
      vars: z.array(keyValue).max(100).optional(),
      scripts: scriptsSchema.optional(),
      items: z.array(itemSchema).max(LIMITS.itemsPerCollection),
    }),
  ]),
);

/** Tools whose command-line runner the generated pipeline uses. */
export const CI_TOOLS = ['bruno', 'postman', 'insomnia'] as const;
export type CiTool = (typeof CI_TOOLS)[number];

/** `a\b/c/` → `a/b/c`; `.` and `..` segments are refused. */
const ciPath = z
  .string()
  .trim()
  .max(300)
  .transform((value) => value.replace(/\\/g, '/').split('/').filter(Boolean).join('/'))
  .refine((value) => value.length > 0, 'Choose a folder inside the repository.')
  .refine(
    (value) => !value.split('/').some((segment) => segment === '.' || segment === '..'),
    'The folder cannot contain "." or ".." segments.',
  );

/**
 * Where the collection lives in the team's repository and how its pipeline runs it: the
 * collection is written there in the tool's format, next to a pipeline that runs it.
 */
export const ciConfigSchema = z.object({
  repository: z.object({
    provider: z.enum(['github', 'azure_devops']),
    /** GitHub numeric id or Azure DevOps repository GUID. */
    id: z.string().trim().min(1).max(200),
    /** GitHub "owner/repo" or Azure DevOps "Project/Repo". */
    name: z.string().trim().min(1).max(300),
    branch: z.string().trim().min(1).max(250),
    path: ciPath,
  }),
  tool: z.enum(CI_TOOLS),
  /** Environment written next to the collection and selected by the pipeline. */
  environmentId: z.string().trim().min(1).max(100).nullable().optional(),
});
export type CiConfig = z.infer<typeof ciConfigSchema>;

export const collectionInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: text(20_000).optional(),
  variables: z.array(variableSchema).max(200).default([]),
  auth: authSchema.default({ type: 'none' }),
  items: z.array(itemSchema).max(LIMITS.itemsPerCollection).default([]),
  headers: z.array(keyValue).max(100).optional(),
  scripts: scriptsSchema.optional(),
  scriptFlow: z.enum(['sandwich', 'sequential']).optional(),
  settings: collectionSettingsSchema.optional(),
  protoFiles: z
    .array(z.object({ name: z.string().trim().min(1).max(500), content: text(LIMITS.protoChars) }))
    .max(100)
    .optional(),
  ci: ciConfigSchema.optional(),
});
export type CollectionInput = z.infer<typeof collectionInputSchema>;

export const environmentInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  variables: z.array(variableSchema).max(200).default([]),
});
export type EnvironmentInput = z.infer<typeof environmentInputSchema>;

export const loadScenarioInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: text(5_000).optional(),
  collectionId: z.string().trim().min(1).max(100),
  environmentId: z.string().trim().max(100).nullable().optional(),
  /** Requests of the collection to replay, with their share of the traffic. */
  requests: z
    .array(z.object({ requestId: id, weight: z.number().min(0).max(1_000).default(1) }))
    .min(1)
    .max(50),
  profile: z.enum(LOAD_PROFILE_TYPES),
  stages: z
    .array(
      z.object({
        durationSec: z.number().int().min(1).max(LIMITS.local.durationSec),
        targetVus: z.number().int().min(0).max(LIMITS.local.vus),
      }),
    )
    .min(1)
    .max(50),
  thinkTimeMs: z.number().int().min(0).max(60_000).default(1_000),
  thresholds: z
    .array(
      z.object({
        metric: z.enum(LOAD_METRICS),
        operator: z.enum(['lt', 'lte', 'gt', 'gte']),
        value: z.number().min(0),
        abortOnFail: z.boolean().optional(),
      }),
    )
    .max(20)
    .default([]),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
});
export type LoadScenarioInput = z.infer<typeof loadScenarioInputSchema>;

export type CollectionSourceKind =
  'manual' | 'adk' | 'postman' | 'insomnia' | 'openapi' | 'generated';

export interface ApiCollection extends CollectionInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly source: { readonly kind: CollectionSourceKind; readonly detail?: string };
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Secret values are personal (each member's vault); the shared variables keep them empty. */
export interface ApiEnvironment {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly variables: readonly Variable[];
  /** Who created it; null for environments created before owners were recorded. */
  readonly createdBy?: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LoadScenario extends LoadScenarioInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ApiRunKind = 'integration' | 'load';
export type ApiRunTarget = 'remote' | 'local';
export type ApiRunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'cancelled';
export const ACTIVE_RUN_STATUSES: readonly ApiRunStatus[] = ['queued', 'running'];

/**
 * One execution. The run is also the unit of work: workers claim queued `remote` runs, and
 * `devkit runner` claims queued `local` runs of the user who requested them.
 */
export interface ApiRun {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: ApiRunKind;
  readonly collectionId: string;
  readonly scenarioId: string | null;
  readonly environmentId: string | null;
  /** Folders or requests of an integration run; empty for the whole collection. */
  readonly itemIds: readonly string[];
  readonly name: string;
  readonly target: ApiRunTarget;
  readonly status: ApiRunStatus;
  readonly requestedBy: string;
  /** Worker or runner that holds the run while it executes. */
  readonly claimedBy: string | null;
  readonly claimLabel: string | null;
  readonly heartbeatAt: Date | null;
  readonly attempts: number;
  /** AES-GCM encrypted {@link ApiRunPayload}; cleared once the run ends. */
  readonly payload: string | null;
  readonly result: CollectionRunResult | LoadSummary | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

/** What the executor needs, frozen when the run is created (later edits do not change it). */
export type ApiRunPayload = RunPayload;

export interface ScenarioDefaults {
  readonly profile: LoadProfileType;
  readonly stages: readonly LoadStage[];
  readonly thresholds: readonly LoadThreshold[];
}

/** Sensible thresholds for each test type: what "healthy" usually means. */
export function defaultThresholds(profile: LoadProfileType): LoadThreshold[] {
  switch (profile) {
    case 'smoke':
      return [
        { metric: 'errorRate', operator: 'lte', value: 0 },
        { metric: 'p95', operator: 'lt', value: 1_000 },
      ];
    case 'breakpoint':
      return [{ metric: 'errorRate', operator: 'lt', value: 0.1, abortOnFail: true }];
    case 'stress':
    case 'spike':
      return [
        { metric: 'errorRate', operator: 'lt', value: 0.05 },
        { metric: 'p95', operator: 'lt', value: 2_000 },
      ];
    default:
      return [
        { metric: 'errorRate', operator: 'lt', value: 0.01 },
        { metric: 'p95', operator: 'lt', value: 500 },
        { metric: 'p99', operator: 'lt', value: 1_500 },
      ];
  }
}
