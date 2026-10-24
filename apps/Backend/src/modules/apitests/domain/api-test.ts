import { z } from 'zod';
import {
  ASSERTION_OPERATORS,
  ASSERTION_SOURCES,
  HTTP_METHODS,
  LOAD_METRICS,
  LOAD_PROFILE_TYPES,
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

export const authSchema: z.ZodType<RequestAuth> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('inherit') }),
  z.object({ type: z.literal('bearer'), token: text(20_000) }),
  z.object({ type: z.literal('basic'), username: text(1_000), password: text(1_000) }),
  z.object({
    type: z.literal('apikey'),
    key: text(500),
    value: text(20_000),
    in: z.enum(['header', 'query']),
  }),
]);

const bodySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.enum(['json', 'text', 'xml']), content: text(LIMITS.bodyChars) }),
  z.object({ mode: z.enum(['form', 'urlencoded']), fields: z.array(keyValue).max(200) }),
]);

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
      items: z.array(itemSchema).max(LIMITS.itemsPerCollection),
    }),
  ]),
);

export const collectionInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: text(20_000).optional(),
  variables: z.array(variableSchema).max(200).default([]),
  auth: authSchema.default({ type: 'none' }),
  items: z.array(itemSchema).max(LIMITS.itemsPerCollection).default([]),
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

/** Secret values are stored encrypted and returned masked (`secret: true`, empty value). */
export interface ApiEnvironment {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly variables: readonly Variable[];
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
