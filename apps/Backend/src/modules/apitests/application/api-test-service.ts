import { randomUUID } from 'node:crypto';
import type { RequestContext } from '../../../shared/context.js';
import { decryptSecret, encryptSecret } from '../../../shared/encryption.js';
import { ApplicationError } from '../../../shared/errors.js';
import type { LlmPort } from '../../agents/application/agent-ports.js';
import { PromptInjectionGuard } from '../../agents/application/prompt-injection-guard.js';
import type { DynamicProviderFactory } from '../../integrations/application/dynamic-provider-factory.js';
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
  type CollectionInput,
  type EnvironmentInput,
  type LoadScenario,
} from '../domain/api-test.js';
import { flattenRequests, selectRequests } from '../engine/collection-runner.js';
import { interpolate, scopeOf } from '../engine/http-request.js';
import { peakVus, profileStages, totalDuration } from '../engine/load-profiles.js';
import type { ApiItem, LoadProfileType, Variable } from '../engine/types.js';
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
import { exportK6 } from '../formats/k6.js';
import { zip } from '../formats/zip.js';
import type { ApiTestStore, RunOutcome } from './api-test-store.js';
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

const SECRET_MASK = '';
const MAX_SOURCE_CHARS = 40_000;

type StoredVariable = Variable & { readonly hasValue?: boolean };

/**
 * Integration and load tests: collections, environments, load scenarios and their runs, plus
 * import/export and AI generation. Runs are queued here and executed by the workers (remote)
 * or by the requesting user's `devkit runner` (local).
 */
export class ApiTestService {
  public constructor(private readonly options: ApiTestServiceOptions) {}

  private get store() {
    return this.options.store;
  }

  // ---------- secrets ----------

  private seal(next: readonly Variable[], previous: readonly Variable[] = []): Variable[] {
    return next.map((variable) => {
      if (!variable.secret) return { ...variable };
      // An empty secret keeps the value already stored for the same key.
      const kept = previous.find((old) => old.key === variable.key && old.secret);
      if (!variable.value && kept) return { ...variable, value: kept.value };
      return {
        ...variable,
        value: variable.value ? encryptSecret(variable.value, this.options.encryptionKey) : '',
      };
    });
  }

  private open(variables: readonly Variable[]): Variable[] {
    return variables.map((variable) =>
      variable.secret && variable.value
        ? { ...variable, value: decryptSecret(variable.value, this.options.encryptionKey) }
        : { ...variable },
    );
  }

  /** What the API returns: secret values are never sent back, only whether one is set. */
  private static mask(variables: readonly Variable[]): StoredVariable[] {
    return variables.map((variable) =>
      variable.secret
        ? { ...variable, value: SECRET_MASK, hasValue: Boolean(variable.value) }
        : variable,
    );
  }

  public static view<T extends { variables: readonly Variable[] }>(item: T): T {
    return { ...item, variables: ApiTestService.mask(item.variables) };
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
        { detail: parsed.error.issues[0]?.message ?? '' },
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

  async getCollection(workspaceId: string, id: string): Promise<ApiCollection> {
    const found = await this.store.getCollection(workspaceId, id);
    if (!found)
      throw new ApplicationError('API_COLLECTION_NOT_FOUND', `Collection '${id}' not found.`, 404);
    return found;
  }

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
      throw new ApplicationError(
        'API_TEST_INVALID',
        `A collection holds at most ${LIMITS.itemsPerCollection} requests.`,
        400,
        [],
        { detail: 'too many requests' },
      );
    }
    const now = new Date();
    return this.store.saveCollection({
      ...input,
      variables: this.seal(input.variables, existing?.variables),
      id: existing?.id ?? randomUUID(),
      workspaceId,
      source: existing?.source ?? source,
      createdBy: existing?.createdBy ?? userId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async deleteCollection(workspaceId: string, id: string): Promise<void> {
    if (!(await this.store.deleteCollection(workspaceId, id))) {
      throw new ApplicationError('API_COLLECTION_NOT_FOUND', `Collection '${id}' not found.`, 404);
    }
  }

  // ---------- environments ----------

  listEnvironments(workspaceId: string) {
    return this.store.listEnvironments(workspaceId);
  }

  async getEnvironment(workspaceId: string, id: string): Promise<ApiEnvironment> {
    const found = await this.store.getEnvironment(workspaceId, id);
    if (!found)
      throw new ApplicationError(
        'API_ENVIRONMENT_NOT_FOUND',
        `Environment '${id}' not found.`,
        404,
      );
    return found;
  }

  async saveEnvironment(
    workspaceId: string,
    input: EnvironmentInput,
    id?: string,
  ): Promise<ApiEnvironment> {
    const existing = id ? await this.getEnvironment(workspaceId, id) : null;
    const now = new Date();
    return this.store.saveEnvironment({
      id: existing?.id ?? randomUUID(),
      workspaceId,
      name: input.name,
      variables: this.seal(input.variables, existing?.variables),
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
        { detail: parsed.error.issues[0]?.message ?? '' },
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

  private async environmentVariables(
    workspaceId: string,
    environmentId?: string | null,
  ): Promise<Variable[]> {
    if (!environmentId) return [];
    return this.open((await this.getEnvironment(workspaceId, environmentId)).variables);
  }

  /**
   * Remote runs execute on the ADK workers, which cannot reach the user's localhost. Catching it
   * here gives a clear message instead of a run full of connection errors.
   */
  private static checkReachable(urls: readonly string[], target: ApiRunTarget): void {
    if (target !== 'remote') return;
    for (const url of urls) {
      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        continue;
      }
      if (isBlockedHostname(host)) {
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
    input: {
      readonly collectionId: string;
      readonly environmentId?: string | null;
      readonly itemIds?: readonly string[];
      readonly target?: ApiRunTarget;
      readonly bail?: boolean;
    },
  ): Promise<ApiRun> {
    const target = input.target ?? 'remote';
    const stored = await this.getCollection(workspaceId, input.collectionId);
    const collection: CollectionInput = { ...stored, variables: this.open(stored.variables) };
    const environment = await this.environmentVariables(workspaceId, input.environmentId);
    const selected = selectRequests(collection, input.itemIds);
    if (!selected.length)
      throw new ApplicationError('API_TEST_INVALID', 'There is no request to run.', 400, [], {
        detail: 'no request',
      });
    const scope = scopeOf(collection.variables, environment);
    ApiTestService.checkReachable(
      selected.map((entry) => interpolate(entry.request.url, scope)),
      target,
    );
    const payload: ApiRunPayload = {
      kind: 'integration',
      collection,
      environment,
      itemIds: [...(input.itemIds ?? [])],
      bail: Boolean(input.bail),
    };
    return this.enqueue({
      workspaceId,
      kind: 'integration',
      collectionId: stored.id,
      scenarioId: null,
      environmentId: input.environmentId ?? null,
      itemIds: [...(input.itemIds ?? [])],
      name: stored.name,
      target,
      requestedBy: userId,
      payload: encryptSecret(JSON.stringify(payload), this.options.encryptionKey),
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
    const collection: CollectionInput = { ...stored, variables: this.open(stored.variables) };
    const environment = await this.environmentVariables(workspaceId, scenario.environmentId);
    const all = flattenRequests(collection);
    const requests = scenario.requests.flatMap((entry) => {
      const found = all.find((item) => item.request.id === entry.requestId);
      return found ? [{ request: found.request, auth: found.auth, weight: entry.weight }] : [];
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
    ApiTestService.checkReachable(
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
      payload: encryptSecret(JSON.stringify(payload), this.options.encryptionKey),
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

  finish(id: string, claimer: string, outcome: RunOutcome) {
    return this.store.finish(id, claimer, outcome);
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
      environments.push(await this.saveEnvironment(workspaceId, environment));
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
    // Exports never contain secret values: the masked view keeps keys with empty values.
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
  const value = JSON.parse(candidate.slice(start, end + 1)) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('the answer is not a JSON object');
  return value as Record<string, unknown>;
}

const COLLECTION_SHAPE = `{
  "collection": {
    "name": "Short name",
    "description": "What the collection covers",
    "variables": [{ "key": "baseUrl", "value": "https://api.example.com" }, { "key": "password", "value": "", "secret": true }],
    "auth": { "type": "none" | "bearer" (token) | "basic" (username, password) | "apikey" (key, value, in: "header"|"query") },
    "items": [
      { "type": "folder", "name": "Orders", "items": [ ...requests ] },
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
        "testCaseId": "id of the saved test case it automates, when the source is a test plan"
      }
    ]
  }
}
Operators: eq, neq, contains, notContains, exists, notExists, lt, lte, gt, gte, matches (regex), isType (string|number|boolean|object|array|null).`;

const INTEGRATION_INSTRUCTION = `You are a senior QA engineer writing API integration tests for ADK.
Write a collection of HTTP requests with assertions from the sources: test cases, Brain pages, specifications, PBIs and the user's requirements.

Rules:
- Cover the main flows, then validation errors (400/422), authentication and permission errors (401/403), not found (404) and boundaries the sources describe. One request per check, named after what it verifies.
- Chain requests the way a client would: capture tokens and created ids into variables and reuse them as {{variable}} in later requests (e.g. create, read, update, delete the same resource).
- Use {{baseUrl}} and variables for hosts, credentials and data that change between environments. Mark credentials as "secret": true with an empty value; never write real secrets.
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
