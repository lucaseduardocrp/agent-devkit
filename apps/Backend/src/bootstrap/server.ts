import { PrismaAuditPersistence } from '../modules/audit/prisma-audit.js';
import { createApp } from '../adapters/http/app.js';
import { createDatabase } from '../adapters/persistence/database-factory.js';
import { createPrismaKnowledgeAdapters } from '../modules/knowledge/adapters/prisma-knowledge.js';
import { InMemoryKnowledgeSearch } from '../modules/knowledge/application/knowledge-search.js';
import {
  PrismaAuthRepository,
  type PrismaAuthClient,
} from '../modules/identity/adapters/prisma-auth-repository.js';
import { InMemoryAuthRepository } from '../modules/identity/adapters/in-memory-auth-repository.js';
import { AuthService } from '../modules/identity/application/auth-service.js';
import { AccessTokenService } from '../modules/identity/application/access-tokens.js';
import {
  InMemoryAccessTokenRepository,
  PrismaAccessTokenRepository,
} from '../modules/identity/adapters/access-token-repositories.js';
import {
  PrismaUserIntegrationStore,
  type PrismaIntegrationsClient,
} from '../modules/integrations/adapters/prisma-integrations-store.js';
import { InMemoryUserIntegrationStore } from '../modules/integrations/adapters/in-memory-integrations-store.js';
import { IntegrationsService } from '../modules/integrations/application/integrations-service.js';
import {
  PrismaWorkspaceRepository,
  type PrismaWorkspacesClient,
} from '../modules/workspaces/adapters/prisma-workspace-repository.js';
import { InMemoryWorkspaceRepository } from '../modules/workspaces/adapters/in-memory-workspace-repository.js';
import { WorkspaceService } from '../modules/workspaces/application/workspace-service.js';
import { sweepPendingFiles } from '../modules/shared/attachment-files.js';
import { InMemoryKnowledgeChunkRepository } from '../modules/knowledge/application/knowledge-provider.js';
import { DynamicProviderFactory } from '../modules/integrations/application/dynamic-provider-factory.js';
import { PrismaAgentRepository } from '../modules/agents/adapters/prisma-agent-repository.js';
import { InMemoryAgentRepository } from '../modules/agents/adapters/in-memory-agent-repository.js';
import { AgentService } from '../modules/agents/application/agent-service.js';
import { PrismaAgentWorkflowRepository } from '../modules/agents/adapters/prisma-agent-workflow-repository.js';
import type { PrismaAgentWorkflowClient } from '../modules/agents/adapters/prisma-agent-workflow-repository.js';
import { PrismaIssueStore } from '../modules/issues/issue-store.js';
import { PrismaPbiStore } from '../modules/pbi/pbi-store.js';
import { PrismaPbiRelationStore } from '../modules/pbi/pbi-relations.js';
import { PrismaFieldMappingStore } from '../modules/field-mapping/prisma-field-mapping.js';
import { PrismaReleaseNoteStore } from '../modules/release-notes/release-note-store.js';
import { PrismaRunStore } from '../modules/issues/run-store.js';
import { PrismaUsageStore } from '../modules/issues/usage-store.js';
import { loadRuntimeConfig } from '../shared/config.js';
import { createCache } from '../shared/cache.js';
import { cachedWorkspaceRepository } from '../modules/workspaces/application/cached-workspace-repository.js';
import { cachedKnowledgeSearch } from '../modules/knowledge/application/knowledge-cache.js';
import { resolveEncryptionKey } from '../shared/encryption.js';
import { InMemorySavedTestPlanStore } from '../modules/testplans/application/saved-test-plans.js';
import { PrismaSavedTestPlanStore } from '../modules/testplans/adapters/prisma-saved-test-plans.js';
import { InMemoryTestSuiteStore } from '../modules/testplans/application/test-suites.js';
import { PrismaTestSuiteStore } from '../modules/testplans/adapters/prisma-test-suites.js';
import { InMemorySpecRepository } from '../modules/spec/application/spec-service.js';
import { PrismaSpecRepository } from '../modules/spec/adapters/prisma-spec-repository.js';
import { PrismaE2eStore } from '../modules/e2e/adapters/prisma-e2e-store.js';
import { PrismaE2eJobQueue } from '../modules/e2e/adapters/prisma-e2e-queue.js';
import { PrismaE2eRunnerTaskStore } from '../modules/e2e/adapters/prisma-runner-task-store.js';
import { createE2eArtifactStore } from '../modules/e2e/adapters/artifact-store-factory.js';
import { HttpE2eDispatcher } from '../modules/e2e/adapters/e2e-dispatchers.js';
import {
  FfmpegVideoTranscoder,
  resolveFfmpegPath,
} from '../modules/e2e/adapters/ffmpeg-transcoder.js';
import { SmtpEmailSender } from '../modules/identity/adapters/smtp-email-sender.js';
import {
  GitHubOAuthProvider,
  GoogleOAuthProvider,
} from '../modules/identity/adapters/oauth-providers.js';
import type { OAuthProvider } from '../modules/identity/application/oauth-provider.js';

const config = loadRuntimeConfig(process.env);
// Stop at startup, not at the first saved integration, when INTEGRATION_ENCRYPTION_KEY is missing.
resolveEncryptionKey();
const database =
  config.databaseProvider && config.databaseUrl
    ? createDatabase({
        databaseProvider: config.databaseProvider,
        databaseUrl: config.databaseUrl,
      })
    : undefined;

// Redis when REDIS_URL is set (shared by every API instance), else this process's memory.
const cache = createCache(process.env);
console.log(`[Cache] Using ${cache.store.kind === 'redis' ? 'Redis' : 'in-process memory'}.`);

const knowledgeAdapters = database
  ? createPrismaKnowledgeAdapters(database.client)
  : {
      search: new InMemoryKnowledgeSearch(),
      repository: new InMemoryKnowledgeChunkRepository(),
    };
// The repository gets its cache inside createApp, around the audited writes.
const knowledge = {
  ...knowledgeAdapters,
  search: cachedKnowledgeSearch(knowledgeAdapters.search, cache),
};

const authRepo = database
  ? new PrismaAuthRepository(database.client as unknown as PrismaAuthClient)
  : new InMemoryAuthRepository();
const emailSender =
  process.env['SMTP_URL'] || process.env['SMTP_HOST']
    ? new SmtpEmailSender({
        host: process.env['SMTP_HOST'] ?? '',
        port: Number(process.env['SMTP_PORT'] ?? 587),
        secure: process.env['SMTP_SECURE'] === 'true',
        user: process.env['SMTP_USER'],
        password: process.env['SMTP_PASSWORD'],
        from: process.env['SMTP_FROM'] ?? 'adk <no-reply@localhost>',
        url: process.env['SMTP_URL'],
      })
    : undefined;
const accessTokens = new AccessTokenService(
  database ? new PrismaAccessTokenRepository(database.client) : new InMemoryAccessTokenRepository(),
  authRepo,
);
const authService = new AuthService(authRepo, {
  accessTokens,
  emailSender,
  // `||`, not `??`: an empty variable from a copied .env.example must not become the secret.
  codeSecret:
    process.env['AUTH_CODE_SECRET']?.trim() ||
    process.env['OAUTH_STATE_SECRET']?.trim() ||
    process.env['INTEGRATION_ENCRYPTION_KEY']?.trim(),
});
const apiPublicUrl = process.env['API_PUBLIC_URL']?.replace(/\/$/, '');
const oauthProviders: OAuthProvider[] = [];
if (apiPublicUrl && process.env['GOOGLE_CLIENT_ID'] && process.env['GOOGLE_CLIENT_SECRET']) {
  oauthProviders.push(
    new GoogleOAuthProvider({
      clientId: process.env['GOOGLE_CLIENT_ID'],
      clientSecret: process.env['GOOGLE_CLIENT_SECRET'],
      callbackUrl: `${apiPublicUrl}/auth/oauth/google/callback`,
    }),
  );
}
if (apiPublicUrl && process.env['GITHUB_CLIENT_ID'] && process.env['GITHUB_CLIENT_SECRET']) {
  oauthProviders.push(
    new GitHubOAuthProvider({
      clientId: process.env['GITHUB_CLIENT_ID'],
      clientSecret: process.env['GITHUB_CLIENT_SECRET'],
      callbackUrl: `${apiPublicUrl}/auth/oauth/github/callback`,
    }),
  );
}

// Every request reads its membership, workspace and groups: served from the cache.
const workspaceRepo = cachedWorkspaceRepository(
  database
    ? new PrismaWorkspaceRepository(database.client as unknown as PrismaWorkspacesClient)
    : new InMemoryWorkspaceRepository(),
  cache,
);
const workspaceService = new WorkspaceService(workspaceRepo, authRepo);

const integrationsStore = database
  ? new PrismaUserIntegrationStore(database.client as unknown as PrismaIntegrationsClient)
  : new InMemoryUserIntegrationStore();
const integrationsService = new IntegrationsService(integrationsStore);
const dynamicProviderFactory = new DynamicProviderFactory(integrationsService);

const agentRepo = database
  ? new PrismaAgentRepository(database.client)
  : new InMemoryAgentRepository();
const agentWorkflowRepo = database
  ? new PrismaAgentWorkflowRepository(database.client as unknown as PrismaAgentWorkflowClient)
  : undefined;
const agentService = new AgentService({
  agentRepository: agentRepo,
  workflowRepository: agentWorkflowRepo,
  dynamicProviderFactory,
  knowledgeSearch: knowledge.search,
});
const savedTestPlans = database
  ? new PrismaSavedTestPlanStore(database.client)
  : new InMemorySavedTestPlanStore();
const testSuites = database
  ? new PrismaTestSuiteStore(database.client)
  : new InMemoryTestSuiteStore();
const specRepository = database
  ? new PrismaSpecRepository(database.client)
  : new InMemorySpecRepository();

const e2eWorkerUrl = process.env['E2E_WORKER_URL']?.trim();
const e2eWorkerToken = process.env['E2E_WORKER_TOKEN']?.trim() ?? '';
if (e2eWorkerUrl && (!database || e2eWorkerToken.length < 16))
  throw new Error(
    'E2E_WORKER_URL requires a database and an E2E_WORKER_TOKEN of at least 16 characters.',
  );

// Videos: Cloudflare R2 when configured, else Postgres, else local disk (development).
const e2eArtifacts = createE2eArtifactStore(process.env, database?.client);
console.log(`[E2E] Test videos are stored in ${e2eArtifacts.kind}.`);

const ffmpegPath = resolveFfmpegPath();
if (!ffmpegPath)
  console.warn(
    '[E2E] FFmpeg not found; test videos will be served as WebM (not playable in VS Code).',
  );

const app = createApp({
  cache,
  auditPersistence: database ? new PrismaAuditPersistence(database.client) : undefined,
  knowledgeSearch: knowledge.search,
  knowledgeRepository: knowledge.repository,
  authService,
  authRouterOptions: {
    oauthProviders,
    oauthStateSecret: process.env['OAUTH_STATE_SECRET']?.trim() || undefined,
    frontendUrl: process.env['FRONTEND_URL'],
    secureCookies: apiPublicUrl?.startsWith('https://') ?? false,
    accessTokens,
  },
  accessTokenService: accessTokens,
  workspaceService,
  integrationsService,
  dynamicProviderFactory,
  agentRepository: agentRepo,
  agentService,
  issueStore: database ? new PrismaIssueStore(database.client) : undefined,
  pbiStore: database ? new PrismaPbiStore(database.client) : undefined,
  pbiRelationStore: database ? new PrismaPbiRelationStore(database.client) : undefined,
  fieldMappingStore: database ? new PrismaFieldMappingStore(database.client) : undefined,
  releaseNoteStore: database ? new PrismaReleaseNoteStore(database.client) : undefined,
  runStore: database ? new PrismaRunStore(database.client) : undefined,
  usageStore: database ? new PrismaUsageStore(database.client) : undefined,
  savedTestPlans,
  testSuites,
  specRepository,
  e2eStore: database ? new PrismaE2eStore(database.client) : undefined,
  e2eQueue: database ? new PrismaE2eJobQueue(database.client) : undefined,
  e2eRunnerTasks: database ? new PrismaE2eRunnerTaskStore(database.client) : undefined,
  e2eArtifacts: e2eArtifacts.store,
  // With a worker URL the API only enqueues; jobs run on the on-demand worker service.
  e2eDispatcher: e2eWorkerUrl
    ? new HttpE2eDispatcher({ url: e2eWorkerUrl, token: e2eWorkerToken })
    : undefined,
  e2eWorkerConcurrency: Number(process.env['E2E_WORKER_CONCURRENCY']) || undefined,
  e2eTranscoder: ffmpegPath ? new FfmpegVideoTranscoder({ ffmpegPath }) : null,
  readinessProbes: database
    ? [{ name: `database:${database.provider}`, check: () => database.check() }]
    : [],
});

const server = app.listen(config.port, () => {
  console.log(`Backend listening on port ${config.port}`);
});

// Files uploaded for an item that was never saved (the save failed or the tab closed
// mid-save) are pending; once they are an hour old nothing can claim them anymore.
const sweepUploads = () =>
  sweepPendingFiles(e2eArtifacts.store).then(
    (removed) => {
      if (removed) console.log(`[Attachments] Removed ${removed} unsaved upload(s).`);
    },
    (error: unknown) => console.error('[Attachments] Could not remove unsaved uploads:', error),
  );
setTimeout(() => void sweepUploads(), 60_000).unref();
setInterval(() => void sweepUploads(), 30 * 60_000).unref();

async function shutdown(): Promise<void> {
  server.close();
  await cache.close();
  await database?.close();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
