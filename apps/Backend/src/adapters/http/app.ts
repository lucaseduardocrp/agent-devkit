import {
  auditWorkspaceDeletion,
  auditRequest,
  auditedRepositories,
  MemoryAuditPersistence,
  type AuditPersistence,
} from '../../modules/audit/audit.js';
import { createAuditRouter } from './audit-routes.js';
import { modulePolicy } from './module-policy.js';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { getHealthStatus } from '../../application/health/get-health-status.js';
import type { KnowledgeSearchPort } from '../../modules/knowledge/application/knowledge-search.js';
import { createRequestContext } from '../../shared/context.js';
import { ApplicationError, toErrorResponse } from '../../shared/errors.js';
import { consoleLogger, createRequestLogger, type Logger } from '../../shared/observability.js';
import { noCache, type Cache } from '../../shared/cache.js';
import { cachedKnowledgeRepository } from '../../modules/knowledge/application/knowledge-cache.js';
import compression from 'compression';
import { createCompatibilityRouter, type RequestContextResolver } from './compatibility-routes.js';
import { AuthService } from '../../modules/identity/application/auth-service.js';
import { AccessTokenService } from '../../modules/identity/application/access-tokens.js';
import { InMemoryAccessTokenRepository } from '../../modules/identity/adapters/access-token-repositories.js';
import { InMemoryAuthRepository } from '../../modules/identity/adapters/in-memory-auth-repository.js';
import { createAuthRouter, type AuthRouterOptions } from './auth-routes.js';
import { createAuthContextResolver } from './auth-middleware.js';
import { WorkspaceService } from '../../modules/workspaces/application/workspace-service.js';
import { InMemoryWorkspaceRepository } from '../../modules/workspaces/adapters/in-memory-workspace-repository.js';
import { createWorkspacesRouter } from './workspaces-routes.js';
import { IntegrationsService } from '../../modules/integrations/application/integrations-service.js';
import { InMemoryUserIntegrationStore } from '../../modules/integrations/adapters/in-memory-integrations-store.js';
import { createIntegrationsRouter } from './integrations-routes.js';

import {
  InMemoryKnowledgeChunkRepository,
  type KnowledgeChunkRepository,
} from '../../modules/knowledge/application/knowledge-provider.js';
import { DynamicProviderFactory } from '../../modules/integrations/application/dynamic-provider-factory.js';
import { createKnowledgeRouter } from './knowledge-routes.js';
import type { LlmPort } from '../../modules/agents/application/agent-ports.js';
import { AgentService } from '../../modules/agents/application/agent-service.js';
import { InMemoryAgentRepository } from '../../modules/agents/adapters/in-memory-agent-repository.js';
import type { AgentRepository } from '../../modules/agents/application/agent-repository.js';
import { createAgentsRouter } from './agents-routes.js';
import { createIssuesRouter } from './issues-routes.js';
import { createAttachmentsRouter } from './attachments-routes.js';
import { createPbiRouter } from './pbi-routes.js';
import { createFieldMappingRouter } from './field-mapping-routes.js';
import {
  InMemoryFieldMappingStore,
  type FieldMappingStore,
} from '../../modules/field-mapping/field-mapping.js';
import {
  InMemoryPbiStore,
  pbiCacheScope,
  withPbiChangeHook,
  type PbiStore,
} from '../../modules/pbi/pbi-store.js';
import { PbiService } from '../../modules/pbi/pbi-service.js';
import {
  InMemoryPbiRelationStore,
  type PbiRelationStore,
} from '../../modules/pbi/pbi-relations.js';
import { EntityAuditLog, auditedIssueStore } from '../../modules/audit/entity-audit.js';
import { createReleaseNoteRouter } from './release-note-routes.js';
import { ReleaseNoteService } from '../../modules/release-notes/release-note-service.js';
import {
  InMemoryReleaseNoteStore,
  type ReleaseNoteStore,
} from '../../modules/release-notes/release-note-store.js';
import { InMemoryRunStore, type RunStore } from '../../modules/issues/run-store.js';
import { RunService } from '../../modules/issues/run-service.js';
import { InMemoryUsageStore, type UsageStore } from '../../modules/issues/usage-store.js';
import { InMemoryIssueStore, type IssueStore } from '../../modules/issues/issue-store.js';

import {
  AiKnowledgeTestPlanGenerator,
  type TestPlanGeneratorPort,
} from '../../modules/testplans/application/generate-test-plan.js';

import { resolveLocale, type SupportedLocale } from '../../shared/i18n.js';
import {
  InMemorySavedTestPlanStore,
  type SavedTestPlanStore,
} from '../../modules/testplans/application/saved-test-plans.js';
import { createSpecRouter } from './spec-routes.js';
import { createSpecWorkflowRouter } from './spec-workflow-routes.js';
import { SpecWorkflows } from '../../modules/spec/application/spec-workflows.js';
import {
  InMemorySpecRepository,
  SpecService,
  type SpecRepository,
} from '../../modules/spec/application/spec-service.js';
import { AgentSpecCollaborator } from '../../modules/spec/adapters/agent-spec-collaborator.js';
import { DesignService } from '../../modules/design/application/design-service.js';
import type { DesignRemoteStore } from '../../modules/design/application/design-service.js';
import { RemoteDesignStore } from '../../modules/design/adapters/remote-design-store.js';
import { createDesignRouter } from './design-routes.js';
import {
  InMemoryTestSuiteStore,
  type TestSuiteStore,
} from '../../modules/testplans/application/test-suites.js';
import { InMemoryE2eStore, type E2eStore } from '../../modules/e2e/application/e2e-store.js';
import { E2eService, type E2eDispatcher } from '../../modules/e2e/application/e2e-service.js';
import { E2eExecutor } from '../../modules/e2e/application/e2e-executor.js';
import { E2eWorker } from '../../modules/e2e/application/e2e-worker.js';
import { InMemoryE2eJobQueue, type E2eJobQueue } from '../../modules/e2e/application/e2e-queue.js';
import { LocalE2eDispatcher } from '../../modules/e2e/adapters/e2e-dispatchers.js';
import { AgentE2eAuthor, type E2eAuthor } from '../../modules/e2e/application/e2e-author.js';
import type { E2eRunner, E2eVideoTranscoder } from '../../modules/e2e/application/e2e-runner.js';
import {
  InMemoryE2eArtifactStore,
  type E2eArtifactStore,
} from '../../modules/e2e/application/artifact-store.js';
import { PlaywrightE2eRunner } from '../../modules/e2e/adapters/playwright-runner.js';
import { createE2eRouter } from './e2e-routes.js';
import { createE2eRunnerRouter } from './e2e-runner-routes.js';
import {
  InMemoryE2eRunnerTaskStore,
  type E2eRunnerTaskStore,
} from '../../modules/e2e/application/runner-tasks.js';
import { LocalE2eRunner } from '../../modules/e2e/application/local-runner.js';
import { E2eLocalRunnerService } from '../../modules/e2e/application/local-runner-service.js';
import { E2eRunReporter } from '../../modules/e2e/application/e2e-reporter.js';
import type { TestManagementResolver } from '../../modules/test-management/application/test-management-provider.js';
import { IntegrationTestManagementResolver } from '../../modules/test-management/adapters/integration-test-management-resolver.js';
import { SavedTestCaseReader } from '../../modules/testplans/application/saved-test-cases.js';
import { GitScriptRepository } from '../../modules/e2e/adapters/git-script-repository.js';
import type { E2eScriptRepository } from '../../modules/e2e/application/script-repository.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ReadinessProbe {
  readonly name: string;
  check(): Promise<void>;
}

export interface AppOptions {
  /** Shared read cache (Redis in production); without one every read goes to the stores. */
  readonly cache?: Cache;
  readonly auditPersistence?: AuditPersistence;
  readonly logger?: Logger;
  readonly readinessProbes?: readonly ReadinessProbe[];
  readonly knowledgeSearch?: KnowledgeSearchPort;
  readonly knowledgeRepository?: KnowledgeChunkRepository;
  readonly testPlanGenerator?: TestPlanGeneratorPort;
  readonly defaultLlm?: LlmPort;
  readonly requestContextResolver?: RequestContextResolver;
  readonly authService?: AuthService;
  readonly authRouterOptions?: AuthRouterOptions;
  /** Used by the default AuthService; pass the same instance in authRouterOptions when injecting one. */
  readonly accessTokenService?: AccessTokenService;
  readonly workspaceService?: WorkspaceService;
  readonly integrationsService?: IntegrationsService;
  readonly dynamicProviderFactory?: DynamicProviderFactory;
  readonly agentRepository?: AgentRepository;
  readonly agentService?: AgentService;
  readonly issueStore?: IssueStore;
  readonly pbiStore?: PbiStore;
  readonly pbiRelationStore?: PbiRelationStore;
  readonly fieldMappingStore?: FieldMappingStore;
  readonly releaseNoteStore?: ReleaseNoteStore;
  readonly runStore?: RunStore;
  /** Token usage reported by MCP clients; defaults to an in-memory ledger. */
  readonly usageStore?: UsageStore;
  readonly savedTestPlans?: SavedTestPlanStore;
  readonly testSuites?: TestSuiteStore;
  readonly specRepository?: SpecRepository;
  readonly designStore?: DesignRemoteStore;
  readonly e2eStore?: E2eStore;
  readonly e2eRunner?: E2eRunner;
  readonly e2eArtifacts?: E2eArtifactStore;
  readonly e2eAuthor?: E2eAuthor;
  readonly e2eScripts?: E2eScriptRepository;
  readonly e2eQueue?: E2eJobQueue;
  /** Browser work handed to users' local runners (`devkit runner`). */
  readonly e2eRunnerTasks?: E2eRunnerTaskStore;
  /**
   * Wakes the workers that run E2E jobs. Without one the API runs jobs itself through an
   * in-process worker (local development).
   */
  readonly e2eDispatcher?: E2eDispatcher;
  readonly e2eWorkerConcurrency?: number;
  /** Converts recordings to MP4; the server wires FFmpeg, tests usually omit it. */
  readonly e2eTranscoder?: E2eVideoTranscoder | null;
  /** Test management platforms for imported cases and published runs; defaults to integrations. */
  readonly testManagement?: TestManagementResolver;
}

const requestIdMiddleware: RequestHandler = (request, response, next) => {
  const suppliedRequestId = request.header('x-request-id');
  const requestId = suppliedRequestId ?? crypto.randomUUID();
  response.setHeader('x-request-id', requestId);
  response.locals.requestId = requestId;
  next();
};

export const localeMiddleware: RequestHandler = (request, response, next) => {
  const rawLocale = request.header('x-locale') ?? request.header('accept-language');
  const locale = resolveLocale(rawLocale);
  response.setHeader('x-locale', locale);
  response.locals.locale = locale;
  next();
};

function resolveRequestId(value: unknown): string {
  return typeof value === 'string' ? value : 'unknown';
}

export const errorMiddleware: ErrorRequestHandler = (error, _request, response, _next) => {
  const requestId = resolveRequestId(response.locals.requestId);
  const locale = (response.locals.locale as SupportedLocale | undefined) ?? 'pt-BR';
  const statusCode = error instanceof ApplicationError ? error.statusCode : 500;
  if (statusCode === 500) {
    console.error(`[UnhandledError ${requestId}]:`, error);
  }
  response.status(statusCode).json(toErrorResponse(error, requestId, locale));
};

const corsMiddleware: RequestHandler = (request, response, next) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  response.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-request-id, x-owner-id, x-workspace-id, x-locale, Accept-Language',
  );
  if (request.method === 'OPTIONS') {
    response.status(204).end();
    return;
  }
  next();
};

export function createApp(options: AppOptions = {}) {
  const app = express();
  const cache = options.cache ?? noCache();
  const authRepository = new InMemoryAuthRepository();
  const accessTokens =
    options.accessTokenService ??
    (options.authService
      ? undefined
      : new AccessTokenService(new InMemoryAccessTokenRepository(), authRepository));
  const authService = options.authService ?? new AuthService(authRepository, { accessTokens });
  const workspaceService =
    options.workspaceService ??
    new WorkspaceService(new InMemoryWorkspaceRepository(), authRepository);
  const integrationsService =
    options.integrationsService ?? new IntegrationsService(new InMemoryUserIntegrationStore());
  const dynamicProviderFactory =
    options.dynamicProviderFactory ?? new DynamicProviderFactory(integrationsService);
  const raw = {
    knowledge: options.knowledgeRepository ?? new InMemoryKnowledgeChunkRepository(),
    specs: options.specRepository ?? new InMemorySpecRepository(),
    tests: options.savedTestPlans ?? new InMemorySavedTestPlanStore(),
  };
  const audit = options.auditPersistence ?? new MemoryAuditPersistence(raw);
  const audited = auditedRepositories(raw, audit);
  const knowledgeRepository = cachedKnowledgeRepository(audited.knowledge, cache);
  const resolveContext =
    options.requestContextResolver ?? createAuthContextResolver(authService, workspaceService);
  const contextResolver: RequestContextResolver = async (req, res) => {
    if (req.context) return req.context;
    const context = await resolveContext(req, res);
    req.context = context;
    return context;
  };

  app.use(corsMiddleware);
  app.use(requestIdMiddleware);
  app.use(localeMiddleware);
  app.use((request, response, next) => {
    void Promise.resolve(contextResolver(request, response))
      .then(() => {
        auditRequest.run(
          { context: () => request.context, operation: `${request.method} ${request.path}` },
          next,
        );
      })
      .catch(next);
  });
  app.use((request, _response, next) => {
    if (request.context?.tokenScope === 'read' && !SAFE_METHODS.has(request.method)) {
      next(new ApplicationError('ACCESS_TOKEN_READ_ONLY', 'This access token is read-only.', 403));
      return;
    }
    next();
  });
  app.use(createRequestLogger(options.logger ?? consoleLogger));
  // Lists such as PBIs and Brain documents are megabytes of repetitive JSON: gzip shrinks them
  // several times over. Media and other incompressible types are left as they are.
  app.use(compression());
  // Design requests may contain up to four transient 5 MB reference images encoded as base64.
  app.use('/design', express.json({ limit: '30mb' }));
  // E2E runs carry the product spec and an optional code diff (up to 500k characters each).
  app.use('/e2e', express.json({ limit: '5mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(modulePolicy);
  const e2eArtifacts = options.e2eArtifacts ?? new InMemoryE2eArtifactStore();
  const agentRepository = options.agentRepository ?? new InMemoryAgentRepository();
  const agentService =
    options.agentService ??
    new AgentService({
      agentRepository,
      dynamicProviderFactory,
      defaultLlm: options.defaultLlm,
      knowledgeSearch: options.knowledgeSearch,
    });

  const testPlanGenerator =
    options.testPlanGenerator ??
    new AiKnowledgeTestPlanGenerator({
      knowledgeSearch: options.knowledgeSearch,
      dynamicProviderFactory,
      defaultLlm: options.defaultLlm,
      agentRepository,
      agentService,
    });

  app.use(createAuditRouter(audit, contextResolver));
  app.use(createAttachmentsRouter(e2eArtifacts, contextResolver, dynamicProviderFactory));
  app.use(createAuthRouter(authService, { accessTokens, ...options.authRouterOptions }));
  app.use(
    createWorkspacesRouter(workspaceService, contextResolver, (id, remove) =>
      auditWorkspaceDeletion(audit, id, remove),
    ),
  );
  app.use(createIntegrationsRouter(integrationsService, contextResolver, dynamicProviderFactory));
  app.use(
    createKnowledgeRouter(
      knowledgeRepository,
      dynamicProviderFactory,
      contextResolver,
      e2eArtifacts,
    ),
  );
  app.use(createAgentsRouter(agentService, contextResolver));
  const entityAudit = new EntityAuditLog(audit);
  const issueStore = auditedIssueStore(options.issueStore ?? new InMemoryIssueStore(), entityAudit);
  const pbiStore = withPbiChangeHook(options.pbiStore ?? new InMemoryPbiStore(), (workspaceId) =>
    cache.invalidate(pbiCacheScope(workspaceId)),
  );
  const fieldMappings = options.fieldMappingStore ?? new InMemoryFieldMappingStore();
  app.use(createFieldMappingRouter(fieldMappings, contextResolver));
  const runService = new RunService(
    options.runStore ?? new InMemoryRunStore(),
    issueStore,
    agentService,
    pbiStore,
    options.usageStore ?? new InMemoryUsageStore(),
    e2eArtifacts,
  );
  void runService
    .recover()
    .catch((error: unknown) => console.error('[RunService] Recovery failed:', error));
  app.use(
    createIssuesRouter(
      issueStore,
      agentService,
      workspaceService,
      runService,
      contextResolver,
      e2eArtifacts,
    ),
  );
  app.use(
    createPbiRouter(
      new PbiService(
        pbiStore,
        integrationsService,
        fetch,
        entityAudit,
        options.pbiRelationStore ?? new InMemoryPbiRelationStore(),
        fieldMappings,
        cache,
        e2eArtifacts,
      ),
      issueStore,
      runService,
      contextResolver,
      workspaceService,
      e2eArtifacts,
    ),
  );
  app.use(
    createReleaseNoteRouter(
      new ReleaseNoteService(
        options.releaseNoteStore ?? new InMemoryReleaseNoteStore(),
        pbiStore,
        agentService,
        entityAudit,
      ),
      contextResolver,
    ),
  );
  app.use(
    createDesignRouter(
      new DesignService(
        options.designStore ?? new RemoteDesignStore(integrationsService),
        agentService,
      ),
      contextResolver,
    ),
  );
  const e2eStore = options.e2eStore ?? new InMemoryE2eStore();
  const e2eQueue = options.e2eQueue ?? new InMemoryE2eJobQueue();
  const e2eScripts = options.e2eScripts ?? new GitScriptRepository(integrationsService);
  const e2eRunnerTasks = options.e2eRunnerTasks ?? new InMemoryE2eRunnerTaskStore();
  const testManagement =
    options.testManagement ?? new IntegrationTestManagementResolver(integrationsService);
  const testSuites = options.testSuites ?? new InMemoryTestSuiteStore();
  // Without a remote worker the API consumes its own queue (local development).
  let e2eDispatcher = options.e2eDispatcher;
  if (!e2eDispatcher) {
    const worker = new E2eWorker({
      queue: e2eQueue,
      concurrency: options.e2eWorkerConcurrency,
      executor: new E2eExecutor({
        store: e2eStore,
        runner: options.e2eRunner ?? new PlaywrightE2eRunner(),
        localRunner: new LocalE2eRunner({ tasks: e2eRunnerTasks, artifacts: e2eArtifacts }),
        transcoder: options.e2eTranscoder,
        scripts: e2eScripts,
        artifacts: e2eArtifacts,
        reporter: new E2eRunReporter({
          store: e2eStore,
          artifacts: e2eArtifacts,
          testManagement,
        }),
        author:
          options.e2eAuthor ??
          new AgentE2eAuthor({
            agents: agentService,
            providers: dynamicProviderFactory,
            defaultLlm: options.defaultLlm,
          }),
      }),
    });
    e2eDispatcher = new LocalE2eDispatcher(worker);
  }
  const e2eService = new E2eService({
    store: e2eStore,
    queue: e2eQueue,
    dispatcher: e2eDispatcher,
    transcoder: options.e2eTranscoder,
    scripts: e2eScripts,
    artifacts: e2eArtifacts,
    agents: agentService,
    testManagement,
    savedCases: new SavedTestCaseReader(audited.tests, testSuites),
  });
  // Picks up work left in the queue and closes runs that lost their job.
  void e2eService
    .recover()
    .catch((error: unknown) => console.error('[E2eService] Recovery failed:', error));
  app.use(createE2eRouter(e2eService, contextResolver));
  app.use(
    createE2eRunnerRouter(
      new E2eLocalRunnerService({
        tasks: e2eRunnerTasks,
        artifacts: e2eArtifacts,
        store: e2eStore,
      }),
    ),
  );
  const specRepository = audited.specs;
  const specCollaborator = new AgentSpecCollaborator(agentService);
  app.use(
    createSpecRouter(
      new SpecService(specRepository, specCollaborator, e2eArtifacts),
      contextResolver,
      e2eArtifacts,
    ),
  );
  app.use(
    createSpecWorkflowRouter(
      new SpecWorkflows(specRepository, knowledgeRepository, specCollaborator, e2eArtifacts),
    ),
  );
  app.use(
    createCompatibilityRouter(
      options.knowledgeSearch,
      testPlanGenerator,
      contextResolver,
      audited.tests,
      testSuites,
      dynamicProviderFactory,
      fieldMappings,
      testManagement,
      e2eArtifacts,
    ),
  );

  app.get('/health', (_request, response) => {
    const requestId = resolveRequestId(response.locals.requestId);
    const locale = response.locals.locale as SupportedLocale;
    const context = createRequestContext(requestId, locale);
    response.status(200).json(getHealthStatus(context));
  });

  app.get('/health/live', (_request, response) => {
    response.status(200).json({ status: 'alive' });
  });

  app.get('/health/ready', async (_request, response) => {
    const checks = await Promise.all(
      (options.readinessProbes ?? []).map(async (probe) => {
        try {
          await probe.check();
          return { name: probe.name, status: 'ready' as const };
        } catch {
          return { name: probe.name, status: 'not-ready' as const };
        }
      }),
    );
    const ready = checks.every((check) => check.status === 'ready');
    response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not-ready', checks });
  });

  app.use(errorMiddleware);
  return app;
}
