import { createDatabase } from '../adapters/persistence/database-factory.js';
import { loadRuntimeConfig } from '../shared/config.js';
import { resolveEncryptionKey } from '../shared/encryption.js';
import {
  PrismaUserIntegrationStore,
  type PrismaIntegrationsClient,
} from '../modules/integrations/adapters/prisma-integrations-store.js';
import { IntegrationsService } from '../modules/integrations/application/integrations-service.js';
import { DynamicProviderFactory } from '../modules/integrations/application/dynamic-provider-factory.js';
import { PrismaAgentRepository } from '../modules/agents/adapters/prisma-agent-repository.js';
import { AgentService } from '../modules/agents/application/agent-service.js';
import { PrismaAgentWorkflowRepository } from '../modules/agents/adapters/prisma-agent-workflow-repository.js';
import type { PrismaAgentWorkflowClient } from '../modules/agents/adapters/prisma-agent-workflow-repository.js';
import { PrismaE2eStore } from '../modules/e2e/adapters/prisma-e2e-store.js';
import { PrismaE2eJobQueue } from '../modules/e2e/adapters/prisma-e2e-queue.js';
import { PrismaE2eRunnerTaskStore } from '../modules/e2e/adapters/prisma-runner-task-store.js';
import { LocalE2eRunner } from '../modules/e2e/application/local-runner.js';
import { createE2eArtifactStore } from '../modules/e2e/adapters/artifact-store-factory.js';
import { GitScriptRepository } from '../modules/e2e/adapters/git-script-repository.js';
import { PlaywrightE2eRunner } from '../modules/e2e/adapters/playwright-runner.js';
import {
  FfmpegVideoTranscoder,
  resolveFfmpegPath,
} from '../modules/e2e/adapters/ffmpeg-transcoder.js';
import { AgentE2eAuthor } from '../modules/e2e/application/e2e-author.js';
import { E2eExecutor } from '../modules/e2e/application/e2e-executor.js';
import { E2eWorker } from '../modules/e2e/application/e2e-worker.js';
import { E2eRunReporter } from '../modules/e2e/application/e2e-reporter.js';
import { IntegrationTestManagementResolver } from '../modules/test-management/adapters/integration-test-management-resolver.js';
import { createE2eWorkerApp } from '../adapters/http/e2e-worker-app.js';

/**
 * On-demand E2E worker. Shares the API's database (queue, runs, videos) and integrations,
 * runs Playwright jobs in parallel and goes quiet when the queue is empty so the host can
 * sleep it. Requires DATABASE_URL, INTEGRATION_ENCRYPTION_KEY (same as the API) and
 * E2E_WORKER_TOKEN.
 */
const config = loadRuntimeConfig(process.env);
// Stop at startup, not at the first saved integration, when INTEGRATION_ENCRYPTION_KEY is missing.
resolveEncryptionKey();
const token = process.env['E2E_WORKER_TOKEN']?.trim() ?? '';
if (!config.databaseProvider || !config.databaseUrl || token.length < 16)
  throw new Error('The E2E worker needs DATABASE_URL and an E2E_WORKER_TOKEN of 16+ characters.');

const database = createDatabase({
  databaseProvider: config.databaseProvider,
  databaseUrl: config.databaseUrl,
});
const integrations = new IntegrationsService(
  new PrismaUserIntegrationStore(database.client as unknown as PrismaIntegrationsClient),
);
const providers = new DynamicProviderFactory(integrations);
const agents = new AgentService({
  agentRepository: new PrismaAgentRepository(database.client),
  workflowRepository: new PrismaAgentWorkflowRepository(
    database.client as unknown as PrismaAgentWorkflowClient,
  ),
  dynamicProviderFactory: providers,
});
const ffmpegPath = resolveFfmpegPath();
const store = new PrismaE2eStore(database.client);
// Same choice as the API (R2 or Postgres), so videos recorded here are served there.
const artifacts = createE2eArtifactStore(process.env, database.client).store;

const worker = new E2eWorker({
  queue: new PrismaE2eJobQueue(database.client),
  concurrency: Number(process.env['E2E_WORKER_CONCURRENCY']) || 2,
  executor: new E2eExecutor({
    store,
    artifacts,
    scripts: new GitScriptRepository(integrations),
    runner: new PlaywrightE2eRunner(),
    // Runs set to execute locally wait here while the user's `devkit runner` drives the browser.
    localRunner: new LocalE2eRunner({
      tasks: new PrismaE2eRunnerTaskStore(database.client),
      artifacts,
    }),
    transcoder: ffmpegPath ? new FfmpegVideoTranscoder({ ffmpegPath }) : null,
    author: new AgentE2eAuthor({ agents, providers }),
    reporter: new E2eRunReporter({
      store,
      artifacts,
      testManagement: new IntegrationTestManagementResolver(integrations),
    }),
  }),
  onIdle: () => console.log('[E2eWorker] Queue empty; idle until the next wake.'),
});

const server = createE2eWorkerApp(worker, token).listen(config.port, () => {
  console.log(`E2E worker ${worker.workerId} listening on port ${config.port}`);
  // Jobs enqueued while this instance was asleep (or a lost wake call) run right away.
  worker.wake();
});

async function shutdown(): Promise<void> {
  server.close();
  await worker.idle();
  await database.close();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
