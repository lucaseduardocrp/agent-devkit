import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RequestContext } from '../../../shared/context.js';
import { decryptSecret, encryptSecret } from '../../../shared/encryption.js';
import { ApplicationError, type ErrorDetail } from '../../../shared/errors.js';
import type { LlmPort } from '../../agents/application/agent-ports.js';
import { PromptInjectionGuard } from '../../agents/application/prompt-injection-guard.js';
import type { DynamicProviderFactory } from '../../integrations/application/dynamic-provider-factory.js';
import {
  formatDuration,
  type RunFinishedEvent,
  type RunNotifier,
} from '../../messaging/application/run-notifier.js';
import {
  collectionInputSchema,
  defaultThresholds,
  LIMITS,
  loadScenarioInputSchema,
  type ApiCollection,
  type ApiEnvironment,
  type ApiRun,
  type ApiRunPayload,
  type ApiRunTarget,
  type CiConfig,
  type CollectionInput,
  type EnvironmentInput,
  type LoadScenario,
} from '../domain/api-test.js';
import { flattenRequests, selectRequests } from '../engine/collection-runner.js';
import { DYNAMIC_VALUE_NAMES } from '../engine/dynamic-values.js';
import { interpolate, mergeHeaders, scopeOf } from '../engine/http-request.js';
import { peakVus, profileStages, totalDuration } from '../engine/load-profiles.js';
import type {
  ApiItem,
  ApiRequestSpec,
  CollectionRunResult,
  LoadProfileType,
  LoadSummary,
  RuntimeState,
  Variable,
} from '../engine/types.js';
import {
  exportAdk,
  exportBruno,
  exportInsomnia,
  exportPostman,
  importCollection,
  sourceKindOf,
  type ExportFormat,
  type ImportFormat,
} from '../formats/index.js';
import {
  buildCiBundle,
  CI_MANIFEST,
  manifestFiles,
  type CiBundle,
  type CiProvider,
  type CiSecret,
} from '../formats/ci.js';
import { exportK6 } from '../formats/k6.js';
import { zip } from '../formats/zip.js';
import type {
  ApiTestStore,
  ExecutorOutcome,
  PersonalValueScope,
  RunOutcome,
} from './api-test-store.js';
import type { CiRepositoryGateway } from './ci-repository.js';
import {
  EMPTY_RUNTIME,
  fill,
  fillVariables,
  normalizeRuntime,
  refs,
  RUNTIME_REF,
  strip,
  stripVariables,
  variableRefs,
  type PersonalScope,
} from './personal-secrets.js';
import { isBlockedHostname } from './target-guard.js';

/** Where generation reads from: saved tests, Brain pages, specs, PBIs, or a document's text. */
export const SOURCE_TYPES = ['testPlan', 'testSuite', 'brain', 'spec', 'pbi'] as const;
export type ApiTestSourceType = (typeof SOURCE_TYPES)[number];
export interface ApiTestSourceRef {
  readonly type: ApiTestSourceType;
  readonly id: string;
}
export interface LoadedSource {
  readonly type: ApiTestSourceType;
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

/** Reads the content of ADK items for generation; implemented with the other modules' stores. */
export interface ApiTestSourceLoader {
  load(context: RequestContext, ref: ApiTestSourceRef): Promise<LoadedSource>;
}

export interface ApiTestDispatcher {
  /** Tells the workers there is remote work. */
  wake(): Promise<void>;
}

export interface ApiTestServiceOptions {
  readonly store: ApiTestStore;
  readonly sources?: ApiTestSourceLoader;
  readonly dispatcher?: ApiTestDispatcher;
  readonly dynamicProviderFactory?: DynamicProviderFactory;
  readonly defaultLlm?: LlmPort;
  /** Defaults to INTEGRATION_ENCRYPTION_KEY. */
  readonly encryptionKey?: string;
  /**
   * The ADK workers reach the user's localhost: a local install with host access on (see
   * shared/host-access.ts). Otherwise remote runs to localhost are refused up front.
   */
  readonly workersReachLocalhost?: boolean;
  /** Tells the workspace's paired chats (Telegram) that a run ended. */
  readonly notifier?: RunNotifier;
  /** The connected Git repositories where collections and their pipelines are written. */
  readonly repositories?: CiRepositoryGateway;
}

/** The commit that wrote a collection and its pipeline to the repository. */
export interface CiPublication {
  /** Null when the repository already had these files. */
  readonly commitUrl: string | null;
  readonly pipelinePath: string;
  readonly files: readonly string[];
  /** Files of an earlier generation that are gone now. */
  readonly removed: readonly string[];
  /** Secrets to create in the CI provider before the pipeline runs. */
  readonly secrets: readonly CiSecret[];
}

export interface GenerationInput {
  readonly kind: 'integration' | 'load';
  readonly sources: readonly ApiTestSourceRef[];
  /** Extra requirements, an API description, or the text of a document to test. */
  readonly instructions?: string;
  readonly baseUrl?: string;
  /** Load generation: the collection whose requests the scenario uses. */
  readonly collectionId?: string;
  readonly llmProvider?: string;
}

export interface GenerationBrief {
  readonly instruction: string;
  readonly context: string;
  readonly sources: readonly {
    readonly type: ApiTestSourceType;
    readonly id: string;
    readonly title: string;
  }[];
  /** How to save the result: the tool and the shape of its input. */
  readonly output: string;
}

const MAX_SOURCE_CHARS = 40_000;
/** Bytes of a response body kept in the result: whole when one request is sent, a preview otherwise. */
const SINGLE_PREVIEW_BYTES = 1024 * 1024;
const RUN_PREVIEW_BYTES = 4 * 1024;

/** A variable as the API returns it: secret values are personal, `hasValue` says if the caller set one. */
export type VariableView = Variable & { readonly hasValue?: boolean };

/** What a member sees of a collection: the shared document and which personal values they have. */
export type CollectionView = Omit<ApiCollection, 'variables'> & {
  readonly variables: VariableView[];
  /** Refs (`var:<key>`, `auth:<owner>:<field>`, ...) the caller has a personal value for. */
  readonly personalSecrets: string[];
};

export type EnvironmentView = Omit<ApiEnvironment, 'variables'> & {
  readonly variables: VariableView[];
  readonly personalSecrets: string[];
};

const dataRowSchema = z
  .record(z.string().max(500), z.string().max(10_000))
  .refine((row) => Object.keys(row).length <= 100, 'A data row has at most 100 columns.');

/** Options of an integration run (POST /integration-tests/runs). */
export const integrationRunInputSchema = z.object({
  collectionId: z.string().trim().min(1).max(100),
  environmentId: z.string().trim().min(1).max(100).nullable().optional(),
  itemIds: z.array(z.string().trim().min(1).max(100)).max(500).default([]),
  target: z.enum(['remote', 'local']).default('remote'),
  bail: z.boolean().default(false),
  /** Runs the selection this many times (data rows win when given). */
  iterations: z.number().int().min(1).max(LIMITS.dataRows).optional(),
  /** Data-driven run: one iteration per row, the columns as variables. */
  data: z.array(dataRowSchema).max(LIMITS.dataRows).optional(),
  /** Pause between requests. */
  delayMs: z.number().int().min(0).max(60_000).optional(),
  /** `grpc-reflect` lists the services of the one selected gRPC request. */
  mode: z.enum(['run', 'grpc-reflect']).default('run'),
  /** Start from the caller's runtime variables and cookies (true by default). */
  useRuntime: z.boolean().default(true),
  /**
   * An unsaved request to run alone: it replaces the saved item with the same id (keeping its
   * folder inheritance) or is added at the root. Credentials typed in it are used for this run
   * only and never stored.
   */
  request: z.record(z.string(), z.unknown()).optional(),
});
export type IntegrationRunInput = z.input<typeof integrationRunInputSchema>;

const invalid = (message: string, detail: string, details: ErrorDetail[] = []) =>
  new ApplicationError('API_TEST_INVALID', message, 400, details, { detail });

/**
 * Integration and load tests: collections, environments, load scenarios and their runs, plus
 * import/export and AI generation. Runs are queued here and executed by the workers (remote)
 * or by the requesting user's `devkit runner` (local).
 *
 * Credentials are personal: saving moves the values the caller typed (secret variables, auth,
 * proxy and certificate secrets) to the caller's encrypted vault and keeps the shared document
 * with empty values or `{{variable}}` references. Runs use the requester's own values.
 */
export class ApiTestService {
  public constructor(private readonly options: ApiTestServiceOptions) {}

  private get store() {
    return this.options.store;
  }

  // ---------- personal values ----------

  private seal(value: string): string {
    return encryptSecret(value, this.options.encryptionKey);
  }

  private unseal(value: string): string | null {
    try {
      return decryptSecret(value, this.options.encryptionKey);
    } catch {
      return null;
    }
  }

  private async personalValues(key: PersonalValueScope): Promise<Map<string, string>> {
    const sealed = await this.store.listPersonalValues(key);
    const values = new Map<string, string>();
    for (const [ref, value] of sealed) {
      const opened = this.unseal(value);
      if (opened !== null) values.set(ref, opened);
    }
    return values;
  }

  private async savePersonalValues(
    key: PersonalValueScope,
    values: ReadonlyMap<string, string>,
  ): Promise<void> {
    if (!values.size) return;
    await this.store.upsertPersonalValues(
      key,
      new Map([...values].map(([ref, value]) => [ref, this.seal(value)] as const)),
    );
  }

  /** Before personal values, secret variables were stored encrypted in the shared document. */
  private openLegacy(variables: readonly Variable[]): Variable[] {
    return variables.map((variable) =>
      variable.secret && variable.value
        ? { ...variable, value: this.unseal(variable.value) ?? '' }
        : { ...variable },
    );
  }

  /** Moves legacy values to an owner's vault without replacing values the owner already set. */
  private async adoptLegacy(
    key: PersonalValueScope,
    extracted: ReadonlyMap<string, string>,
  ): Promise<void> {
    const existing = await this.store.listPersonalValues(key);
    const missing = new Map([...extracted].filter(([ref]) => !existing.has(ref)));
    try {
      await this.savePersonalValues(key, missing);
    } catch (error) {
      // E.g. the owner's account no longer exists: the values are dropped, never left shared.
      console.warn('[ApiTestService] Could not keep legacy credentials:', error);
    }
  }

  /**
   * Collections saved before credentials became personal may hold secret variable values and
   * literal credentials. They move to the vault of the collection's creator, once.
   */
  private async migrateCollection(stored: ApiCollection): Promise<ApiCollection> {
    if (!strip(stored).extracted.size) return stored;
    // Re-read right before writing so a concurrent save is not overwritten with old content
    // (a document migrated meanwhile has nothing left to move and is written back unchanged).
    const fresh =
      (await this.store.getCollection(stored.workspaceId, stored.id)) ??
      /* v8 ignore next -- deleted between the two reads */ stored;
    const { shared, extracted } = strip({ ...fresh, variables: this.openLegacy(fresh.variables) });
    await this.adoptLegacy(
      {
        workspaceId: fresh.workspaceId,
        userId: fresh.createdBy,
        scope: 'collection',
        scopeId: fresh.id,
      },
      extracted,
    );
    return this.store.saveCollection({ ...shared, updatedAt: fresh.updatedAt });
  }

  /**
   * Environments had no owner: legacy secret values move to the creator when known (environments
   * created since owners are recorded) and are cleared otherwise.
   */
  private async migrateEnvironment(stored: ApiEnvironment): Promise<ApiEnvironment> {
    if (!stripVariables(stored.variables).extracted.size) return stored;
    const fresh =
      (await this.store.getEnvironment(stored.workspaceId, stored.id)) ??
      /* v8 ignore next -- deleted between the two reads */ stored;
    const { shared, extracted } = stripVariables(this.openLegacy(fresh.variables));
    if (fresh.createdBy) {
      await this.adoptLegacy(
        {
          workspaceId: fresh.workspaceId,
          userId: fresh.createdBy,
          scope: 'environment',
          scopeId: fresh.id,
        },
        extracted,
      );
    }
    return this.store.saveEnvironment({ ...fresh, variables: shared });
  }

  private static maskVariables(variables: readonly Variable[], mine: ReadonlySet<string>) {
    return variables.map((variable): VariableView =>
      variable.secret
        ? { ...variable, value: '', hasValue: mine.has(`var:${variable.key}`) }
        : { ...variable },
    );
  }

  /** Secret variables with an empty value (exports, files for other tools). */
  public static view<T extends { variables: readonly Variable[] }>(item: T): T {
    return {
      ...item,
      variables: item.variables.map((variable) =>
        variable.secret ? { ...variable, value: '' } : variable,
      ),
    };
  }

  /** The collection as a member sees it: the shared document and their own personal refs. */
  async collectionView(collection: ApiCollection, userId: string): Promise<CollectionView> {
    const shared = strip(collection).shared;
    const mine = new Set(
      (
        await this.store.listPersonalValues({
          workspaceId: collection.workspaceId,
          userId,
          scope: 'collection',
          scopeId: collection.id,
        })
      ).keys(),
    );
    const available = new Set(refs(shared));
    return {
      ...shared,
      variables: ApiTestService.maskVariables(shared.variables, mine),
      personalSecrets: [...mine].filter((ref) => available.has(ref)).sort(),
    };
  }

  async environmentView(environment: ApiEnvironment, userId: string): Promise<EnvironmentView> {
    const mine = new Set(
      (
        await this.store.listPersonalValues({
          workspaceId: environment.workspaceId,
          userId,
          scope: 'environment',
          scopeId: environment.id,
        })
      ).keys(),
    );
    const available = new Set(variableRefs(environment.variables));
    return {
      ...environment,
      variables: ApiTestService.maskVariables(environment.variables, mine),
      personalSecrets: [...mine].filter((ref) => available.has(ref)).sort(),
    };
  }

  async getCollectionView(workspaceId: string, userId: string, id: string) {
    return this.collectionView(await this.getCollection(workspaceId, id), userId);
  }

  async listEnvironmentViews(workspaceId: string, userId: string): Promise<EnvironmentView[]> {
    const environments = await this.listEnvironments(workspaceId);
    return Promise.all(environments.map((item) => this.environmentView(item, userId)));
  }

  /** Removes one of the caller's own personal values (the scope must exist in the workspace). */
  async clearPersonalValue(
    workspaceId: string,
    userId: string,
    scope: Exclude<PersonalScope, 'runtime'>,
    scopeId: string,
    ref: string,
  ): Promise<void> {
    if (scope === 'collection') await this.findCollection(workspaceId, scopeId);
    else await this.findEnvironment(workspaceId, scopeId);
    await this.store.deletePersonalValue({ workspaceId, userId, scope, scopeId }, ref);
  }

  // ---------- runtime state ----------

  private runtimeKey(workspaceId: string, userId: string, collectionId: string) {
    return { workspaceId, userId, scope: 'runtime' as const, scopeId: collectionId };
  }

  private async readRuntime(key: PersonalValueScope): Promise<RuntimeState> {
    const sealed = (await this.store.listPersonalValues(key)).get(RUNTIME_REF);
    const opened = sealed ? this.unseal(sealed) : null;
    // Only JSON written by writeRuntime is stored; a value that cannot be opened is ignored.
    return opened ? (normalizeRuntime(JSON.parse(opened)) ?? EMPTY_RUNTIME) : EMPTY_RUNTIME;
  }

  private async writeRuntime(key: PersonalValueScope, state: unknown): Promise<RuntimeState> {
    const runtime = normalizeRuntime(state) ?? EMPTY_RUNTIME;
    await this.savePersonalValues(key, new Map([[RUNTIME_REF, JSON.stringify(runtime)]]));
    return runtime;
  }

  /** The caller's runtime variables and cookies of a collection (personal). */
  async getRuntime(workspaceId: string, userId: string, collectionId: string) {
    await this.findCollection(workspaceId, collectionId);
    return this.readRuntime(this.runtimeKey(workspaceId, userId, collectionId));
  }

  async setRuntime(workspaceId: string, userId: string, collectionId: string, state: unknown) {
    await this.findCollection(workspaceId, collectionId);
    return this.writeRuntime(this.runtimeKey(workspaceId, userId, collectionId), state);
  }

  async clearRuntime(workspaceId: string, userId: string, collectionId: string): Promise<void> {
    await this.findCollection(workspaceId, collectionId);
    await this.store.deleteUserPersonalScope(this.runtimeKey(workspaceId, userId, collectionId));
  }

  // ---------- collections ----------

  /** Fills ids and defaults the agents and other tools may leave out, then validates. */
  public static parseCollection(raw: unknown): CollectionInput {
    const fill = (items: unknown): unknown =>
      Array.isArray(items)
        ? items.map((item: unknown) => {
            if (!item || typeof item !== 'object') return item;
            const value = item as Record<string, unknown>;
            const isFolder = value['type'] === 'folder' || Array.isArray(value['items']);
            return {
              ...value,
              id: typeof value['id'] === 'string' && value['id'] ? value['id'] : randomUUID(),
              type: isFolder ? 'folder' : 'request',
              ...(isFolder
                ? { items: fill(value['items']) }
                : {
                    method:
                      typeof value['method'] === 'string' ? value['method'].toUpperCase() : 'GET',
                    assertions: Array.isArray(value['assertions'])
                      ? value['assertions'].map((assertion: unknown) =>
                          assertion &&
                          typeof assertion === 'object' &&
                          !(assertion as { id?: unknown }).id
                            ? { ...assertion, id: randomUUID() }
                            : assertion,
                        )
                      : [],
                  }),
            };
          })
        : items;
    const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const parsed = collectionInputSchema.safeParse({ ...value, items: fill(value['items'] ?? []) });
    if (!parsed.success) {
      throw new ApplicationError(
        'API_TEST_INVALID',
        'The collection is not valid.',
        400,
        parsed.error.issues
          .slice(0, 20)
          .map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        { detail: parsed.error.issues[0]!.message },
      );
    }
    return { ...parsed.data, items: ApiTestService.uniqueIds(parsed.data.items) };
  }

  /** Repeated ids (e.g. a pasted request) would make runs and scenarios ambiguous. */
  private static uniqueIds(items: readonly ApiItem[], seen = new Set<string>()): ApiItem[] {
    return items.map((item) => {
      const id = seen.has(item.id) ? randomUUID() : item.id;
      seen.add(id);
      return item.type === 'folder'
        ? { ...item, id, items: ApiTestService.uniqueIds(item.items, seen) }
        : { ...item, id };
    });
  }

  listCollections(workspaceId: string) {
    return this.store.listCollections(workspaceId);
  }

  /** The stored row, legacy or not; only for existence checks. */
  private async findCollection(workspaceId: string, id: string): Promise<ApiCollection> {
    const found = await this.store.getCollection(workspaceId, id);
    if (!found)
      throw new ApplicationError('API_COLLECTION_NOT_FOUND', `Collection '${id}' not found.`, 404);
    return found;
  }

  /** The shared collection: never holds credentials (legacy ones are migrated on access). */
  async getCollection(workspaceId: string, id: string): Promise<ApiCollection> {
    return this.migrateCollection(await this.findCollection(workspaceId, id));
  }

  /**
   * Saves the shared collection. Credentials typed by `userId` go to their own vault; empty
   * ones keep the values they already have.
   */
  async saveCollection(
    workspaceId: string,
    userId: string,
    input: CollectionInput,
    id?: string,
    source: ApiCollection['source'] = { kind: 'manual' },
  ): Promise<ApiCollection> {
    const existing = id ? await this.getCollection(workspaceId, id) : null;
    const count = flattenRequests(input).length;
    if (count > LIMITS.itemsPerCollection) {
      throw invalid(
        `A collection holds at most ${LIMITS.itemsPerCollection} requests.`,
        'too many requests',
      );
    }
    const now = new Date();
    const { shared, extracted } = strip({
      ...input,
      id: existing?.id ?? randomUUID(),
      workspaceId,
      source: existing?.source ?? source,
      createdBy: existing?.createdBy ?? userId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await this.savePersonalValues(
      { workspaceId, userId, scope: 'collection', scopeId: shared.id },
      extracted,
    );
    return this.store.saveCollection(shared);
  }

  async deleteCollection(workspaceId: string, id: string): Promise<void> {
    if (!(await this.store.deleteCollection(workspaceId, id))) {
      throw new ApplicationError('API_COLLECTION_NOT_FOUND', `Collection '${id}' not found.`, 404);
    }
    await this.store.deletePersonalScope(workspaceId, 'collection', id);
    await this.store.deletePersonalScope(workspaceId, 'runtime', id);
  }

  // ---------- environments ----------

  async listEnvironments(workspaceId: string): Promise<ApiEnvironment[]> {
    const environments = await this.store.listEnvironments(workspaceId);
    return Promise.all(environments.map((item) => this.migrateEnvironment(item)));
  }

  private async findEnvironment(workspaceId: string, id: string): Promise<ApiEnvironment> {
    const found = await this.store.getEnvironment(workspaceId, id);
    if (!found)
      throw new ApplicationError(
        'API_ENVIRONMENT_NOT_FOUND',
        `Environment '${id}' not found.`,
        404,
      );
    return found;
  }

  async getEnvironment(workspaceId: string, id: string): Promise<ApiEnvironment> {
    return this.migrateEnvironment(await this.findEnvironment(workspaceId, id));
  }

  async saveEnvironment(
    workspaceId: string,
    userId: string,
    input: EnvironmentInput,
    id?: string,
  ): Promise<ApiEnvironment> {
    const existing = id ? await this.getEnvironment(workspaceId, id) : null;
    const now = new Date();
    const environmentId = existing?.id ?? randomUUID();
    const { shared, extracted } = stripVariables(input.variables);
    await this.savePersonalValues(
      { workspaceId, userId, scope: 'environment', scopeId: environmentId },
      extracted,
    );
    return this.store.saveEnvironment({
      id: environmentId,
      workspaceId,
      name: input.name,
      variables: shared,
      createdBy: existing ? (existing.createdBy ?? null) : userId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async deleteEnvironment(workspaceId: string, id: string): Promise<void> {
    if (!(await this.store.deleteEnvironment(workspaceId, id))) {
      throw new ApplicationError(
        'API_ENVIRONMENT_NOT_FOUND',
        `Environment '${id}' not found.`,
        404,
      );
    }
    await this.store.deletePersonalScope(workspaceId, 'environment', id);
  }

  // ---------- load scenarios ----------

  /** Stages and thresholds a new scenario of a test type starts with. */
  static scenarioDefaults(profile: LoadProfileType, vus = 20, durationSec = 300) {
    return {
      profile,
      stages: profileStages(profile, { vus, durationSec }),
      thresholds: defaultThresholds(profile),
    };
  }

  listScenarios(workspaceId: string) {
    return this.store.listScenarios(workspaceId);
  }

  async getScenario(workspaceId: string, id: string): Promise<LoadScenario> {
    const found = await this.store.getScenario(workspaceId, id);
    if (!found)
      throw new ApplicationError(
        'LOAD_SCENARIO_NOT_FOUND',
        `Load scenario '${id}' not found.`,
        404,
      );
    return found;
  }

  async saveScenario(
    workspaceId: string,
    userId: string,
    raw: unknown,
    id?: string,
  ): Promise<LoadScenario> {
    const parsed = loadScenarioInputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApplicationError(
        'API_TEST_INVALID',
        'The load scenario is not valid.',
        400,
        parsed.error.issues
          .slice(0, 20)
          .map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        { detail: parsed.error.issues[0]!.message },
      );
    }
    const input = parsed.data;
    const collection = await this.getCollection(workspaceId, input.collectionId);
    const requestIds = new Set(flattenRequests(collection).map((entry) => entry.request.id));
    const missing = input.requests.filter((entry) => !requestIds.has(entry.requestId));
    if (missing.length) {
      throw new ApplicationError(
        'API_TEST_INVALID',
        'The scenario uses requests that are not in the collection.',
        400,
        missing.map((entry) => ({ requestId: entry.requestId })),
        { detail: 'unknown request' },
      );
    }
    if (input.environmentId) await this.getEnvironment(workspaceId, input.environmentId);
    const existing = id ? await this.getScenario(workspaceId, id) : null;
    const now = new Date();
    return this.store.saveScenario({
      ...input,
      id: existing?.id ?? randomUUID(),
      workspaceId,
      createdBy: existing?.createdBy ?? userId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async deleteScenario(workspaceId: string, id: string): Promise<void> {
    if (!(await this.store.deleteScenario(workspaceId, id))) {
      throw new ApplicationError(
        'LOAD_SCENARIO_NOT_FOUND',
        `Load scenario '${id}' not found.`,
        404,
      );
    }
  }

  // ---------- runs ----------

  /** The environment with the requester's own secret values. */
  private async runEnvironment(
    workspaceId: string,
    userId: string,
    environmentId?: string | null,
  ): Promise<{ variables: Variable[]; name?: string }> {
    if (!environmentId) return { variables: [] };
    const environment = await this.getEnvironment(workspaceId, environmentId);
    const values = await this.personalValues({
      workspaceId,
      userId,
      scope: 'environment',
      scopeId: environment.id,
    });
    return { variables: fillVariables(environment.variables, values), name: environment.name };
  }

  /** The collection with the requester's own credentials. */
  private async runCollection<T extends ApiCollection>(collection: T, userId: string): Promise<T> {
    const values = await this.personalValues({
      workspaceId: collection.workspaceId,
      userId,
      scope: 'collection',
      scopeId: collection.id,
    });
    return fill(collection, values);
  }

  /** Validates an unsaved request sent by the editor (same defaults as a saved one). */
  private static parseRequest(raw: Record<string, unknown>): ApiRequestSpec {
    const item = ApiTestService.parseCollection({ name: 'request', items: [raw] }).items[0];
    if (item?.type !== 'request') throw invalid('The request is not valid.', 'request');
    return item;
  }

  /** Puts the unsaved request in place of the saved one, or at the root when it is new. */
  private static placeRequest(
    items: readonly ApiItem[],
    request: ApiRequestSpec,
  ): { items: ApiItem[]; placed: boolean } {
    let placed = false;
    const next = items.map((item): ApiItem => {
      if (placed) return item;
      if (item.id === request.id) {
        if (item.type === 'folder') throw invalid('The request id is a folder.', 'request');
        placed = true;
        return request;
      }
      if (item.type !== 'folder') return item;
      const inner = ApiTestService.placeRequest(item.items, request);
      if (!inner.placed) return item;
      placed = true;
      return { ...item, items: inner.items };
    });
    return { items: next, placed };
  }

  /**
   * Remote runs execute on the ADK workers, which cannot reach the user's localhost unless ADK is
   * a local install with host access. Catching it here gives a clear message instead of a run full
   * of connection errors. Works for http(s), ws(s), grpc(s), tcp, tls and udp URLs.
   */
  private checkReachable(urls: readonly string[], target: ApiRunTarget): void {
    if (target !== 'remote' || this.options.workersReachLocalhost) return;
    for (const url of urls) {
      let host: string;
      try {
        const trimmed = url.trim();
        host = new URL(/^[a-z][\w+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`)
          .hostname;
      } catch {
        continue;
      }
      if (host && isBlockedHostname(host)) {
        throw new ApplicationError(
          'API_TEST_TARGET_LOCAL',
          `${host} is not reachable from the ADK workers. Run it on your computer instead (target "local", with devkit runner open).`,
          400,
          [{ host }],
          { host },
        );
      }
    }
  }

  private async enqueue(run: Parameters<ApiTestStore['createRun']>[0]): Promise<ApiRun> {
    const created = await this.store.createRun(run);
    if (run.target === 'remote') await this.options.dispatcher?.wake().catch(() => undefined);
    return { ...created, payload: null };
  }

  async startIntegrationRun(
    workspaceId: string,
    userId: string,
    raw: IntegrationRunInput,
  ): Promise<ApiRun> {
    const parsed = integrationRunInputSchema.safeParse(raw);
    if (!parsed.success) {
      throw invalid(
        'The run options are not valid.',
        parsed.error.issues[0]!.message,
        parsed.error.issues
          .slice(0, 20)
          .map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      );
    }
    const input = parsed.data;
    const target = input.target;
    let stored: ApiCollection = await this.getCollection(workspaceId, input.collectionId);
    let itemIds = [...input.itemIds];
    if (input.request) {
      const request = ApiTestService.parseRequest(input.request);
      const placed = ApiTestService.placeRequest(stored.items, request);
      stored = { ...stored, items: placed.placed ? placed.items : [...stored.items, request] };
      itemIds = [request.id];
    }
    const collection = await this.runCollection(stored, userId);
    const environment = await this.runEnvironment(workspaceId, userId, input.environmentId);
    const selected = selectRequests(collection, itemIds);
    if (!selected.length) throw invalid('There is no request to run.', 'no request');
    if (
      input.mode === 'grpc-reflect' &&
      (selected.length !== 1 || selected[0]?.request.kind !== 'grpc')
    ) {
      throw invalid('Listing gRPC services needs exactly one gRPC request.', 'grpc-reflect');
    }
    const runtime = input.useRuntime
      ? await this.readRuntime(this.runtimeKey(workspaceId, userId, stored.id))
      : null;
    const scope = scopeOf(collection.variables, environment.variables, runtime?.variables ?? []);
    this.checkReachable(
      selected.map((entry) => interpolate(entry.request.url, scope)),
      target,
    );
    const iterations = input.data?.length ? input.data.length : (input.iterations ?? 1);
    const single = selected.length === 1 && iterations === 1;
    const payload: ApiRunPayload = {
      kind: 'integration',
      collection,
      environment: environment.variables,
      ...(environment.name ? { environmentName: environment.name } : {}),
      itemIds,
      bail: input.bail,
      mode: input.mode,
      ...(runtime ? { runtime } : {}),
      ...(input.iterations ? { iterations: input.iterations } : {}),
      ...(input.data?.length ? { data: input.data } : {}),
      ...(input.delayMs ? { delayMs: input.delayMs } : {}),
      previewBytes:
        single || input.mode === 'grpc-reflect' ? SINGLE_PREVIEW_BYTES : RUN_PREVIEW_BYTES,
    };
    return this.enqueue({
      workspaceId,
      kind: 'integration',
      collectionId: stored.id,
      scenarioId: null,
      environmentId: input.environmentId ?? null,
      itemIds,
      name: stored.name,
      target,
      requestedBy: userId,
      payload: this.seal(JSON.stringify(payload)),
    });
  }

  async startLoadRun(
    workspaceId: string,
    userId: string,
    input: {
      readonly scenarioId: string;
      readonly target?: ApiRunTarget;
      /** The user confirms they may put load on the target system. */
      readonly authorized: boolean;
    },
  ): Promise<ApiRun> {
    if (!input.authorized) {
      throw new ApplicationError(
        'LOAD_TEST_NOT_AUTHORIZED',
        'Confirm that you are allowed to put load on the target system before starting a load test.',
        400,
      );
    }
    const target = input.target ?? 'remote';
    const scenario = await this.getScenario(workspaceId, input.scenarioId);
    const limits = LIMITS[target];
    const vus = peakVus(scenario.stages);
    const duration = totalDuration(scenario.stages);
    if (vus > limits.vus || duration > limits.durationSec) {
      throw new ApplicationError(
        'LOAD_TEST_LIMIT',
        `On ${target === 'remote' ? 'the ADK workers' : 'your computer'} a load test may use at most ${limits.vus} virtual users for ${limits.durationSec / 60} minutes.`,
        400,
        [{ vus, durationSec: duration, maxVus: limits.vus, maxDurationSec: limits.durationSec }],
        { vus: limits.vus, minutes: limits.durationSec / 60 },
      );
    }
    const active = await this.store.listRuns(workspaceId, { scenarioId: scenario.id, limit: 5 });
    if (active.some((run) => run.status === 'queued' || run.status === 'running')) {
      throw new ApplicationError(
        'LOAD_TEST_ALREADY_RUNNING',
        'This scenario is already running.',
        409,
      );
    }
    const stored = await this.getCollection(workspaceId, scenario.collectionId);
    const collection = await this.runCollection(stored, userId);
    const environment = (await this.runEnvironment(workspaceId, userId, scenario.environmentId))
      .variables;
    const all = flattenRequests(collection);
    const requests = scenario.requests.flatMap((entry) => {
      const found = all.find((item) => item.request.id === entry.requestId);
      if (!found) return [];
      const inheritedHeaders = mergeHeaders(
        collection.headers,
        ...found.folders.map((folder) => folder.headers),
      );
      return [
        {
          request: found.request,
          auth: found.auth,
          weight: entry.weight,
          ...(inheritedHeaders.length ? { inheritedHeaders } : {}),
        },
      ];
    });
    if (!requests.length) {
      throw new ApplicationError(
        'API_TEST_INVALID',
        'The requests of this scenario are no longer in the collection.',
        400,
        [],
        { detail: 'no request' },
      );
    }
    const scope = scopeOf(collection.variables, environment);
    this.checkReachable(
      requests.map((entry) => interpolate(entry.request.url, scope)),
      target,
    );
    const payload: ApiRunPayload = {
      kind: 'load',
      plan: {
        requests,
        variables: [...collection.variables, ...environment],
        stages: scenario.stages,
        thinkTimeMs: scenario.thinkTimeMs,
        thresholds: scenario.thresholds,
        ...(collection.settings ? { settings: collection.settings } : {}),
        ...(scenario.timeoutMs ? { timeoutMs: scenario.timeoutMs } : {}),
      },
      maxVus: limits.vus,
    };
    return this.enqueue({
      workspaceId,
      kind: 'load',
      collectionId: stored.id,
      scenarioId: scenario.id,
      environmentId: scenario.environmentId ?? null,
      itemIds: [],
      name: scenario.name,
      target,
      requestedBy: userId,
      payload: this.seal(JSON.stringify(payload)),
    });
  }

  listRuns(workspaceId: string, filter: Parameters<ApiTestStore['listRuns']>[1]) {
    return this.store.listRuns(workspaceId, filter);
  }

  async getRun(workspaceId: string, id: string): Promise<ApiRun> {
    const run = await this.store.getRun(workspaceId, id);
    if (!run) throw new ApplicationError('API_RUN_NOT_FOUND', `Run '${id}' not found.`, 404);
    return { ...run, payload: null };
  }

  async cancelRun(workspaceId: string, id: string): Promise<ApiRun> {
    await this.getRun(workspaceId, id);
    await this.store.cancel(workspaceId, id);
    return this.getRun(workspaceId, id);
  }

  async deleteRun(workspaceId: string, id: string): Promise<void> {
    await this.getRun(workspaceId, id);
    if (!(await this.store.deleteRun(workspaceId, id))) {
      throw new ApplicationError('API_RUN_ACTIVE', 'Cancel the run before deleting it.', 409);
    }
  }

  /** For executors: the run's frozen input, decrypted. */
  payloadOf(run: ApiRun): ApiRunPayload {
    if (!run.payload)
      throw new ApplicationError('API_RUN_NOT_FOUND', 'The run has no input left.', 410);
    return JSON.parse(decryptSecret(run.payload, this.options.encryptionKey)) as ApiRunPayload;
  }

  claimRemote(workerId: string) {
    return this.store.claimRemote(workerId);
  }

  claimLocal(workspaceId: string, userId: string, runner: { id: string; label: string }) {
    return this.store.claimLocal({ workspaceId, userId }, runner);
  }

  /** Runner side: the run must belong to the runner's user and workspace. */
  async ownedRun(workspaceId: string, userId: string, id: string): Promise<ApiRun> {
    const run = await this.store.getRun(workspaceId, id);
    if (!run || run.requestedBy !== userId || run.target !== 'local') {
      throw new ApplicationError('API_RUN_NOT_FOUND', `Run '${id}' not found.`, 404);
    }
    return run;
  }

  heartbeat(id: string, claimer: string, partial?: ApiRun['result']) {
    return this.store.heartbeat(id, claimer, partial);
  }

  /**
   * Records the outcome. The runtime state of an integration run goes to the requester's vault,
   * never into the run row (other members read runs).
   */
  async finish(run: ApiRun, claimer: string, outcome: ExecutorOutcome): Promise<boolean> {
    const { runtime, ...recorded } = outcome;
    const saved = await this.store.finish(run.id, claimer, recorded);
    if (saved && runtime && run.kind === 'integration') {
      try {
        if (await this.store.getCollection(run.workspaceId, run.collectionId)) {
          await this.writeRuntime(
            this.runtimeKey(run.workspaceId, run.requestedBy, run.collectionId),
            runtime,
          );
        }
      } catch (error) {
        console.warn('[ApiTestService] Could not keep the runtime state:', error);
      }
    }
    if (saved) await this.options.notifier?.runFinished(runFinishedEvent(run, recorded));
    return saved;
  }

  sweep(staleBefore: Date, maxAttempts: number) {
    return this.store.sweep(staleBefore, maxAttempts);
  }

  // ---------- import / export ----------

  async importCollection(
    workspaceId: string,
    userId: string,
    input: { readonly content: string; readonly format?: ImportFormat; readonly name?: string },
  ): Promise<{ collection: ApiCollection; environments: ApiEnvironment[]; format: ImportFormat }> {
    const imported = importCollection(input.content, input.format);
    const collection = await this.saveCollection(
      workspaceId,
      userId,
      { ...imported.collection, ...(input.name ? { name: input.name } : {}) },
      undefined,
      { kind: sourceKindOf(imported.format) },
    );
    const environments: ApiEnvironment[] = [];
    for (const environment of imported.environments) {
      environments.push(await this.saveEnvironment(workspaceId, userId, environment));
    }
    return { collection, environments, format: imported.format };
  }

  /** A file to download: JSON for ADK, Postman and Insomnia, a zip for Bruno. */
  async exportCollection(
    workspaceId: string,
    id: string,
    format: ExportFormat,
    environmentIds: readonly string[] = [],
  ): Promise<{ fileName: string; contentType: string; body: string | Buffer }> {
    const stored = await this.getCollection(workspaceId, id);
    // Exports hold the shared document only: credentials are personal and never exported.
    const collection = ApiTestService.view(stored);
    const environments = await Promise.all(
      environmentIds.map(async (environmentId) =>
        ApiTestService.view(await this.getEnvironment(workspaceId, environmentId)),
      ),
    );
    const base =
      stored.name
        .replace(/[^\w.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase() || 'collection';
    switch (format) {
      case 'adk':
        return {
          fileName: `${base}.adk.json`,
          contentType: 'application/json',
          body: JSON.stringify(exportAdk(collection, environments), null, 2),
        };
      case 'postman':
        return {
          fileName: `${base}.postman_collection.json`,
          contentType: 'application/json',
          body: JSON.stringify(exportPostman(collection), null, 2),
        };
      case 'insomnia':
        return {
          fileName: `${base}.insomnia.json`,
          contentType: 'application/json',
          body: JSON.stringify(exportInsomnia(collection), null, 2),
        };
      case 'bruno':
        return {
          fileName: `${base}.bruno.zip`,
          contentType: 'application/zip',
          body: zip(exportBruno(collection, environments)),
        };
    }
  }

  async exportK6(
    workspaceId: string,
    scenarioId: string,
  ): Promise<{ fileName: string; body: string }> {
    const scenario = await this.getScenario(workspaceId, scenarioId);
    const collection = ApiTestService.view(
      await this.getCollection(workspaceId, scenario.collectionId),
    );
    const environment = scenario.environmentId
      ? ApiTestService.view(await this.getEnvironment(workspaceId, scenario.environmentId))
          .variables
      : [];
    const base =
      scenario.name
        .replace(/[^\w.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase() || 'load-test';
    return { fileName: `${base}.k6.js`, body: exportK6(collection, scenario, environment) };
  }

  // ---------- pipelines ----------

  private get repositories(): CiRepositoryGateway {
    if (!this.options.repositories)
      throw new ApplicationError(
        'API_TEST_CI_UNAVAILABLE',
        'Repository access is not available on this server.',
        501,
      );
    return this.options.repositories;
  }

  /** The repositories of the connected GitHub and Azure DevOps integrations. */
  ciRepositories(workspaceId: string) {
    return this.repositories.listRepositories(workspaceId);
  }

  ciBranches(workspaceId: string, provider: CiProvider, repositoryId: string) {
    return this.repositories.listBranches(workspaceId, provider, repositoryId);
  }

  /** What the pipeline of the saved collection consists of; secrets are exported empty. */
  async previewCi(
    workspaceId: string,
    id: string,
  ): Promise<CiBundle & { ci: CiConfig; name: string }> {
    const stored = await this.getCollection(workspaceId, id);
    const ci = stored.ci;
    if (!ci)
      throw invalid(
        'Choose the repository, branch and folder of the pipeline first.',
        'pipeline not configured',
      );
    const environment = ci.environmentId
      ? ApiTestService.view(await this.getEnvironment(workspaceId, ci.environmentId))
      : null;
    const bundle = buildCiBundle(ApiTestService.view(stored), environment, {
      provider: ci.repository.provider,
      branch: ci.repository.branch,
      path: ci.repository.path,
      tool: ci.tool,
    });
    return { ...bundle, ci, name: stored.name };
  }

  /**
   * Writes the collection and its pipeline to the repository of its CI settings in one commit,
   * and removes the files an earlier generation wrote there that are gone now.
   */
  async publishCi(workspaceId: string, id: string): Promise<CiPublication> {
    const { ci, name, files, pipelinePath, secrets } = await this.previewCi(workspaceId, id);
    // The stored name is for display: the provider's own name addresses the repository.
    const { repositories } = await this.repositories.listRepositories(workspaceId);
    const repository = repositories.find(
      (item) => item.provider === ci.repository.provider && item.id === ci.repository.id,
    );
    if (!repository)
      throw new ApplicationError(
        'API_TEST_CI_REPOSITORY_NOT_FOUND',
        'The repository of the pipeline is not available. Check the GitHub or Azure DevOps integration.',
        404,
      );
    const ref = { ...ci.repository, name: repository.name };
    const existing = new Set(await this.repositories.listFiles(workspaceId, ref));
    const written = new Set(files.map((file) => file.path));
    const manifestPath = `${ref.path}/${CI_MANIFEST}`;
    const previous = existing.has(manifestPath)
      ? await this.repositories.readFile(workspaceId, ref, manifestPath)
      : null;
    const removed = manifestFiles(previous, ref.path).filter(
      (path) => !written.has(path) && existing.has(path),
    );
    const commitUrl = await this.repositories.commitFiles(
      workspaceId,
      ref,
      [...files, ...removed.map((path) => ({ path, content: null }))],
      `Update the API tests of "${name}" (generated by ADK)`,
    );
    return {
      commitUrl,
      pipelinePath,
      files: files.map((file) => file.path),
      removed,
      secrets,
    };
  }

  // ---------- generation ----------

  private async loadSources(
    context: RequestContext,
    refs: readonly ApiTestSourceRef[],
  ): Promise<LoadedSource[]> {
    if (refs.length && !this.options.sources) {
      throw new ApplicationError(
        'API_TEST_SOURCES_UNAVAILABLE',
        'Sources cannot be read in this ADK.',
        503,
      );
    }
    const loaded: LoadedSource[] = [];
    for (const ref of refs) loaded.push(await this.options.sources!.load(context, ref));
    return loaded;
  }

  /**
   * The grounded instruction and context for authoring tests, without calling an LLM, so an
   * MCP host model can write them and save them with the returned tool (host mode).
   */
  async prepareGeneration(
    workspaceId: string,
    context: RequestContext,
    input: GenerationInput,
  ): Promise<GenerationBrief> {
    if (!input.sources.length && !input.instructions?.trim()) {
      throw new ApplicationError(
        'API_TEST_INVALID',
        'Choose at least one source or describe what to test.',
        400,
        [],
        { detail: 'no source' },
      );
    }
    const sources = await this.loadSources(context, input.sources);
    let collectionSummary = '';
    if (input.kind === 'load') {
      if (!input.collectionId) {
        throw new ApplicationError(
          'API_TEST_INVALID',
          'A load scenario is generated from an existing collection.',
          400,
          [],
          { detail: 'collectionId' },
        );
      }
      const collection = await this.getCollection(workspaceId, input.collectionId);
      collectionSummary = flattenRequests(collection)
        .map(
          (entry) =>
            `- ${entry.request.id}: ${entry.request.method} ${entry.request.url} (${[...entry.path, entry.request.name].join(' / ')})`,
        )
        .join('\n');
    }
    const context_ = [
      input.baseUrl ? `Base URL of the system under test: ${input.baseUrl}` : '',
      input.instructions?.trim()
        ? `Requirements from the user:\n${input.instructions.trim().slice(0, MAX_SOURCE_CHARS)}`
        : '',
      collectionSummary ? `Requests of the collection (id: method url):\n${collectionSummary}` : '',
      ...sources.map(
        (source) =>
          `--- [${source.type}: ${source.title}] ---\n${source.text.slice(0, MAX_SOURCE_CHARS)}`,
      ),
    ]
      .filter(Boolean)
      .join('\n\n');
    return {
      instruction: input.kind === 'integration' ? INTEGRATION_INSTRUCTION : LOAD_INSTRUCTION,
      context: context_,
      sources: sources.map(({ type, id, title }) => ({ type, id, title })),
      output:
        input.kind === 'integration'
          ? 'Save with integration_save_collection { collection: <JSON> }, then offer integration_run.'
          : `Save with load_save_scenario { scenario: <JSON> } (collectionId "${input.collectionId}"), then offer load_run after the user confirms they may load the target.`,
    };
  }

  /** Server mode: the workspace LLM writes the tests and they are saved right away. */
  async generate(
    workspaceId: string,
    userId: string,
    context: RequestContext,
    input: GenerationInput,
  ): Promise<{
    collection?: ApiCollection;
    scenario?: LoadScenario;
    sources: GenerationBrief['sources'];
  }> {
    const brief = await this.prepareGeneration(workspaceId, context, input);
    let llm: LlmPort | null = null;
    if (this.options.dynamicProviderFactory && context.ownerId) {
      llm = await this.options.dynamicProviderFactory.resolveLlmProvider(
        context.ownerId,
        input.llmProvider,
      );
    }
    llm ??= this.options.defaultLlm ?? null;
    if (!llm) {
      throw new ApplicationError(
        'API_TEST_NO_LLM',
        'No AI provider is configured for this workspace. Configure one in Integrations, or generate from your assistant through MCP (host mode).',
        400,
      );
    }
    const { payload, nonce } = PromptInjectionGuard.wrapWithSandboxEnvelope(brief.context);
    const instruction = PromptInjectionGuard.buildSystemInstruction(brief.instruction, nonce);
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const correction = attempt
        ? `\n\nThe previous answer was rejected (${lastError}). Answer again with only the JSON object.`
        : '';
      const completion = await llm.complete({
        prompt: payload,
        instruction: `${instruction}${correction}`,
      });
      const text = PromptInjectionGuard.verifyOutput(completion.text, instruction);
      try {
        const json = extractJson(text);
        if (input.kind === 'integration') {
          const raw = (json['collection'] ?? json) as Record<string, unknown>;
          const parsed = ApiTestService.parseCollection(raw);
          const collection = await this.saveCollection(workspaceId, userId, parsed, undefined, {
            kind: 'generated',
            detail: brief.sources
              .map((source) => `${source.type}:${source.title}`)
              .join(', ')
              .slice(0, 500),
          });
          return { collection, sources: brief.sources };
        }
        const raw = (json['scenario'] ?? json) as Record<string, unknown>;
        const scenario = await this.saveScenario(workspaceId, userId, {
          ...raw,
          collectionId: input.collectionId,
        });
        return { scenario, sources: brief.sources };
      } catch (error) {
        lastError = error instanceof Error ? error.message.slice(0, 300) : 'invalid JSON';
      }
    }
    throw new ApplicationError(
      'API_TEST_GENERATION_FAILED',
      `The model did not return valid tests: ${lastError}`,
      502,
      [],
      { detail: lastError },
    );
  }
}

/** The JSON object in a model answer, with or without a Markdown fence around it. */
export function extractJson(text: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const candidate = (fenced ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in the answer');
  // The slice runs from `{` to `}`, so it parses to an object or throws.
  return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
}

const COLLECTION_SHAPE = `{
  "collection": {
    "name": "Short name",
    "description": "What the collection covers",
    "variables": [{ "key": "baseUrl", "value": "https://api.example.com" }, { "key": "token", "value": "", "secret": true }],
    "auth": { "type": "none" } | { "type": "bearer", "token": "{{token}}" } | { "type": "basic", "username": "{{user}}", "password": "{{password}}" } | { "type": "apikey", "key": "x-api-key", "value": "{{apiKey}}", "in": "header" | "query" },
    "headers": [{ "key": "Accept", "value": "application/json" }],
    "scripts": { "preRequest": "JavaScript run before every request", "tests": "JavaScript run after every response" },
    "items": [
      { "type": "folder", "name": "Orders", "auth": { "type": "inherit" }, "headers": [], "items": [ ...requests ] },
      {
        "type": "request",
        "name": "Create order",
        "description": "Which acceptance criterion or test case it covers",
        "method": "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS",
        "url": "{{baseUrl}}/orders",
        "headers": [{ "key": "Accept", "value": "application/json" }],
        "query": [{ "key": "page", "value": "1" }],
        "body": { "mode": "none" } | { "mode": "json", "content": "{\\"sku\\":\\"A1\\"}" } | { "mode": "urlencoded", "fields": [...] },
        "auth": { "type": "inherit" },
        "assertions": [
          { "source": "status", "operator": "eq", "expected": "201" },
          { "source": "json", "path": "data.id", "operator": "exists" },
          { "source": "header", "path": "content-type", "operator": "contains", "expected": "json" },
          { "source": "duration", "operator": "lt", "expected": "1000" }
        ],
        "captures": [{ "variable": "orderId", "source": "json", "path": "data.id" }],
        "scripts": { "preRequest": "...", "postResponse": "...", "tests": "test('has items', () => expect(res.getBody().items).to.have.length.above(0));" },
        "testCaseId": "id of the saved test case it automates, when the source is a test plan"
      }
    ]
  }
}
Operators: eq, neq, contains, notContains, exists, notExists, lt, lte, gt, gte, matches (regex), isType (string|number|boolean|object|array|null).
Other request kinds (set "kind"): "graphql" with "graphql": { "query", "variables"? } (sent as a POST); "grpc" with a grpc:// or grpcs:// URL and "grpc": { "method": "package.Service/Method", "message": "{...}", "reflection": true }; "websocket" with a ws:// or wss:// URL and "websocket": { "messages": [{ "content": "..." }] }.`;

const MOCK_HELPERS = DYNAMIC_VALUE_NAMES.map((name) => `{{${name}}}`).join(', ');

const INTEGRATION_INSTRUCTION = `You are a senior QA engineer writing API integration tests for ADK.
Write a collection of HTTP requests with assertions from the sources: test cases, Brain pages, specifications, PBIs and the user's requirements.

Rules:
- Cover the main flows, then validation errors (400/422), authentication and permission errors (401/403), not found (404) and boundaries the sources describe. One request per check, named after what it verifies.
- Chain requests the way a client would: capture tokens and created ids into variables and reuse them as {{variable}} in later requests (e.g. create, read, update, delete the same resource).
- Use {{baseUrl}} and variables for hosts, credentials and data that change between environments.
- Credentials are personal to each workspace member: always write them as {{variables}} (in auth fields too, e.g. "token": "{{token}}") and declare those variables with "secret": true and an empty value; each member types their own value in ADK. Never write real secrets or literal tokens.
- Headers every request needs (Accept, a tenant id) go in the collection or folder "headers"; requests override them by name.
- Prefer assertions and captures; use scripts only for checks they cannot express. Scripts are JavaScript calling the ADK API: adk.getVar/adk.setVar, adk.getEnvVar, adk.sendRequest, req (getUrl, setHeader, setBody), res (getStatus, getHeader, getBody, getResponseTime), test("name", () => { ... }) and expect (Chai). Never use bru, pm or postman: call adk.
- Fill request bodies, queries and headers with realistic data instead of placeholders such as "string" or "test". Mock helpers generate a new value on every request; write them as {{$helper}}, e.g. "name": "{{$randomFullName}}", "email": "{{$randomEmail}}", "cpf": "{{$randomCPF}}". Available helpers: ${MOCK_HELPERS}. A helper can stand for a JSON number or boolean only outside quotes, e.g. "age": {{$randomAge}}. Use fixed values where an assertion needs to know the data (a known login, a boundary value).
- Assert what the sources state: status codes, required fields, values and formats. Do not invent endpoints, fields or rules the sources do not support; when an endpoint path is not given, infer the most likely REST path and say so in the request description.
- When a source is a test plan, map each test case to requests and set testCaseId to the case id.
- Group requests in folders by resource or flow.
Answer with only one JSON object in this shape:
${COLLECTION_SHAPE}`;

const LOAD_INSTRUCTION = `You are a performance engineer designing a load test scenario for ADK.
Choose the test type and its parameters from the sources and the user's requirements, using only requests of the given collection.

Test types (profile):
- smoke: 1-2 users for up to a minute, to check the scenario works.
- load: the expected traffic (ramp up, hold, ramp down).
- stress: steps above the expected traffic (up to 150 %) to see how the system degrades.
- spike: low traffic, a sudden burst, back to low, to check recovery.
- soak: the expected traffic for a long time (30 min or more) to find leaks.
- breakpoint: a steady ramp to find the breaking point, with an abortOnFail threshold.
- custom: hand-written stages.

Rules:
- Weight the requests like real usage (reads usually far more frequent than writes).
- Thresholds: latency in ms (avg, p50, p90, p95, p99, max), errorRate and checksRate as 0..1 ratios, rps in requests per second. Base them on the SLAs in the sources; otherwise use errorRate < 0.01 and p95 < 500.
- At most 200 virtual users and 15 minutes unless the user asks for more.
Answer with only one JSON object in this shape:
{
  "scenario": {
    "name": "Checkout under expected peak",
    "description": "Why these numbers",
    "requests": [{ "requestId": "<id from the collection>", "weight": 3 }],
    "profile": "load",
    "stages": [{ "durationSec": 60, "targetVus": 50 }, { "durationSec": 300, "targetVus": 50 }, { "durationSec": 60, "targetVus": 0 }],
    "thinkTimeMs": 1000,
    "thresholds": [{ "metric": "p95", "operator": "lt", "value": 500 }, { "metric": "errorRate", "operator": "lt", "value": 0.01 }]
  }
}`;

export const GENERATION_FORMAT = { collection: COLLECTION_SHAPE };

function runFinishedEvent(run: ApiRun, outcome: RunOutcome): RunFinishedEvent {
  let summary = outcome.error?.split('\n')[0]?.slice(0, 300) ?? '';
  if (outcome.result && run.kind === 'integration') {
    const result = outcome.result as CollectionRunResult;
    summary = `${result.passed}/${result.total} passed · ${formatDuration(result.durationMs)}`;
  } else if (outcome.result) {
    const result = outcome.result as LoadSummary;
    summary = [
      `${result.totalRequests} requests`,
      `${(result.errorRate * 100).toFixed(1)}% errors`,
      `p95 ${Math.round(result.latency.p95)} ms`,
      `${result.rps.toFixed(1)} req/s`,
    ].join(' · ');
  }
  return {
    workspaceId: run.workspaceId,
    kind: run.kind,
    name: run.name,
    status: outcome.status,
    summary,
  };
}
