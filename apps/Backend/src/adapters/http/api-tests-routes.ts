import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { RequestContext } from '../../shared/context.js';
import { ApplicationError } from '../../shared/errors.js';
import {
  ApiTestService,
  SOURCE_TYPES,
  type GenerationInput,
} from '../../modules/apitests/application/api-test-service.js';
import {
  environmentInputSchema,
  type ApiCollection,
  type ApiRun,
  type ApiRunKind,
} from '../../modules/apitests/domain/api-test.js';
import { flattenRequests } from '../../modules/apitests/engine/collection-runner.js';
import { LOAD_PROFILE_TYPES } from '../../modules/apitests/engine/types.js';
import {
  EXPORT_FORMATS,
  IMPORT_FORMATS,
  exportBruno,
} from '../../modules/apitests/formats/index.js';
import { requireAuth, requireModulePermission } from './auth-middleware.js';
import { parseBody, parseParams } from './validation.js';

const idParams = z.object({ id: z.string().trim().min(1).max(100) });
const target = z.enum(['remote', 'local']).default('remote');
const sourceRef = z.object({ type: z.enum(SOURCE_TYPES), id: z.string().trim().min(1).max(500) });
const generation = z.object({
  sources: z.array(sourceRef).max(20).default([]),
  instructions: z.string().max(40_000).optional(),
  baseUrl: z.string().trim().max(2_000).optional(),
  llmProvider: z.string().trim().min(1).max(100).optional(),
});
const runnerFields = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  name: z.string().trim().min(1).max(100),
  platform: z.string().trim().min(1).max(40),
  version: z.string().trim().min(1).max(40),
});

/** Every route runs requireModulePermission or the runner check first, so the context exists. */
function context(request: Request): RequestContext & { workspaceId: string; actorId: string } {
  const value = request.context;
  if (!value?.workspaceId || !value.actorId) {
    throw new ApplicationError('WORKSPACE_REQUIRED', 'Workspace context is required.', 400);
  }
  return value as RequestContext & { workspaceId: string; actorId: string };
}

function disconnectSignal(response: Response): AbortSignal {
  const controller = new AbortController();
  response.on('close', () => controller.abort());
  return controller.signal;
}

function collectionSummary(collection: ApiCollection) {
  return {
    id: collection.id,
    name: collection.name,
    description: collection.description ?? '',
    source: collection.source,
    requestCount: flattenRequests(collection).length,
    updatedAt: collection.updatedAt,
  };
}

/** Lists drop the per-request results and the load timeline; the run itself has them. */
function runSummary(run: ApiRun) {
  const { payload: _payload, result, ...rest } = run;
  if (!result) return { ...rest, result: null };
  if ('results' in result) {
    const { results: _results, ...totals } = result;
    return { ...rest, result: totals };
  }
  const { timeline: _timeline, perRequest: _perRequest, ...totals } = result;
  return { ...rest, result: totals };
}

const send = (response: Response, status: number, body: unknown) => {
  response.setHeader('cache-control', 'no-store');
  response.status(status).json(body);
};

/**
 * Integration tests (/integration-tests), overload tests (/load-tests) and the protocol of
 * `devkit runner` for local runs (/api-tests/runner). Load scenarios read the collections of
 * integration tests, so load routes also need view access to Integration Tests.
 */
export function createApiTestsRouter(service: ApiTestService): Router {
  const router = Router();
  const it = (operation: 'view' | 'edit' | 'delete') =>
    requireModulePermission('integrationTests', operation);
  const load = (operation: 'view' | 'edit' | 'delete') => [
    requireModulePermission('loadTests', operation),
    requireModulePermission('integrationTests', 'view'),
  ];
  const wrap =
    (handler: (request: Request, response: Response) => Promise<void> | void) =>
    (request: Request, response: Response, next: (error?: unknown) => void) => {
      Promise.resolve()
        .then(() => handler(request, response))
        .catch(next);
    };

  const runOf = async (request: Request, kind: ApiRunKind) => {
    const { workspaceId } = context(request);
    const run = await service.getRun(workspaceId, parseParams(idParams, request).id);
    if (run.kind !== kind) throw new ApplicationError('API_RUN_NOT_FOUND', 'Run not found.', 404);
    return run;
  };

  // ---------- Integration tests: collections ----------

  router.get(
    '/integration-tests/collections',
    requireAuth,
    it('view'),
    wrap(async (request, response) => {
      const collections = await service.listCollections(context(request).workspaceId);
      send(response, 200, { collections: collections.map(collectionSummary) });
    }),
  );

  router.post(
    '/integration-tests/collections',
    requireAuth,
    it('edit'),
    wrap(async (request, response) => {
      const { workspaceId, actorId } = context(request);
      const input = ApiTestService.parseCollection(request.body);
      const collection = await service.saveCollection(workspaceId, actorId, input);
      send(response, 201, { collection: ApiTestService.view(collection) });
    }),
  );

  router.post(
    '/integration-tests/collections/import',
    requireAuth,
    it('edit'),
    wrap(async (request, response) => {
      const { workspaceId, actorId } = context(request);
      const input = parseBody(
        z.object({
          content: z.string().min(1).max(5_000_000),
          format: z.enum(IMPORT_FORMATS).optional(),
          name: z.string().trim().min(1).max(200).optional(),
        }),
        request,
      );
      const imported = await service.importCollection(workspaceId, actorId, input);
      send(response, 201, {
        format: imported.format,
        collection: ApiTestService.view(imported.collection),
        environments: imported.environments.map((environment) => ApiTestService.view(environment)),
      });
    }),
  );

  router.get(
    '/integration-tests/collections/:id',
    requireAuth,
    it('view'),
    wrap(async (request, response) => {
      const collection = await service.getCollection(
        context(request).workspaceId,
        parseParams(idParams, request).id,
      );
      send(response, 200, { collection: ApiTestService.view(collection) });
    }),
  );

  router.put(
    '/integration-tests/collections/:id',
    requireAuth,
    it('edit'),
    wrap(async (request, response) => {
      const { workspaceId, actorId } = context(request);
      const input = ApiTestService.parseCollection(request.body);
      const collection = await service.saveCollection(
        workspaceId,
        actorId,
        input,
        parseParams(idParams, request).id,
      );
      send(response, 200, { collection: ApiTestService.view(collection) });
    }),
  );

  router.delete(
    '/integration-tests/collections/:id',
    requireAuth,
    it('delete'),
    wrap(async (request, response) => {
      await service.deleteCollection(
        context(request).workspaceId,
        parseParams(idParams, request).id,
      );
      send(response, 200, { success: true });
    }),
  );

  router.get(
    '/integration-tests/collections/:id/export',
    requireAuth,
    it('view'),
    wrap(async (request, response) => {
      const { workspaceId } = context(request);
      const query = z
        .object({
          format: z.enum(EXPORT_FORMATS).default('adk'),
          environmentIds: z.string().max(2_000).optional(),
          // `files` returns Bruno's files as JSON (for assistants) instead of a zip.
          as: z.enum(['file', 'files']).default('file'),
        })
        .parse(request.query);
      const id = parseParams(idParams, request).id;
      const environmentIds =
        query.environmentIds
          ?.split(',')
          .map((value) => value.trim())
          .filter(Boolean) ?? [];
      if (query.format === 'bruno' && query.as === 'files') {
        const collection = ApiTestService.view(await service.getCollection(workspaceId, id));
        const environments = await Promise.all(
          environmentIds.map(async (environmentId) =>
            ApiTestService.view(await service.getEnvironment(workspaceId, environmentId)),
          ),
        );
        send(response, 200, { files: exportBruno(collection, environments) });
        return;
      }
      const file = await service.exportCollection(workspaceId, id, query.format, environmentIds);
      response.setHeader('content-type', file.contentType);
      response.setHeader('content-disposition', `attachment; filename="${file.fileName}"`);
      response.setHeader('cache-control', 'no-store');
      response.status(200).send(file.body);
    }),
  );

  // ---------- Integration tests: environments ----------

  router.get(
    '/integration-tests/environments',
    requireAuth,
    it('view'),
    wrap(async (request, response) => {
      const environments = await service.listEnvironments(context(request).workspaceId);
      send(response, 200, {
        environments: environments.map((environment) => ApiTestService.view(environment)),
      });
    }),
  );

  router.post(
    '/integration-tests/environments',
    requireAuth,
    it('edit'),
    wrap(async (request, response) => {
      const environment = await service.saveEnvironment(
        context(request).workspaceId,
        parseBody(environmentInputSchema, request),
      );
      send(response, 201, { environment: ApiTestService.view(environment) });
    }),
  );

  router.put(
    '/integration-tests/environments/:id',
    requireAuth,
    it('edit'),
    wrap(async (request, response) => {
      const environment = await service.saveEnvironment(
        context(request).workspaceId,
        parseBody(environmentInputSchema, request),
        parseParams(idParams, request).id,
      );
      send(response, 200, { environment: ApiTestService.view(environment) });
    }),
  );

  router.delete(
    '/integration-tests/environments/:id',
    requireAuth,
    it('delete'),
    wrap(async (request, response) => {
      await service.deleteEnvironment(
        context(request).workspaceId,
        parseParams(idParams, request).id,
      );
      send(response, 200, { success: true });
    }),
  );

  // ---------- Integration tests: runs and generation ----------

  router.post(
    '/integration-tests/runs',
    requireAuth,
    it('edit'),
    wrap(async (request, response) => {
      const { workspaceId, actorId } = context(request);
      const input = parseBody(
        z.object({
          collectionId: z.string().trim().min(1).max(100),
          environmentId: z.string().trim().min(1).max(100).nullable().optional(),
          itemIds: z.array(z.string().trim().min(1).max(100)).max(500).default([]),
          target,
          bail: z.boolean().default(false),
        }),
        request,
      );
      send(response, 201, { run: await service.startIntegrationRun(workspaceId, actorId, input) });
    }),
  );

  router.get(
    '/integration-tests/runs',
    requireAuth,
    it('view'),
    wrap(async (request, response) => {
      const query = z
        .object({
          collectionId: z.string().max(100).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query);
      const runs = await service.listRuns(context(request).workspaceId, {
        kind: 'integration',
        ...query,
      });
      send(response, 200, { runs: runs.map(runSummary) });
    }),
  );

  router.get(
    '/integration-tests/runs/:id',
    requireAuth,
    it('view'),
    wrap(async (request, response) => {
      send(response, 200, { run: await runOf(request, 'integration') });
    }),
  );

  router.post(
    '/integration-tests/runs/:id/cancel',
    requireAuth,
    it('edit'),
    wrap(async (request, response) => {
      const run = await runOf(request, 'integration');
      send(response, 200, { run: await service.cancelRun(run.workspaceId, run.id) });
    }),
  );

  router.delete(
    '/integration-tests/runs/:id',
    requireAuth,
    it('delete'),
    wrap(async (request, response) => {
      const run = await runOf(request, 'integration');
      await service.deleteRun(run.workspaceId, run.id);
      send(response, 200, { success: true });
    }),
  );

  const generationInput = (request: Request, kind: GenerationInput['kind']): GenerationInput => {
    const body = parseBody(
      kind === 'load'
        ? generation.extend({ collectionId: z.string().trim().min(1).max(100) })
        : generation,
      request,
    );
    return { kind, ...body };
  };

  router.post(
    '/integration-tests/generate/prepare',
    requireAuth,
    it('edit'),
    wrap(async (request, response) => {
      const value = context(request);
      send(response, 200, {
        brief: await service.prepareGeneration(
          value.workspaceId,
          value,
          generationInput(request, 'integration'),
        ),
      });
    }),
  );

  router.post(
    '/integration-tests/generate',
    requireAuth,
    it('edit'),
    wrap(async (request, response) => {
      const value = context(request);
      const result = await service.generate(
        value.workspaceId,
        value.actorId,
        value,
        generationInput(request, 'integration'),
      );
      send(response, 201, {
        collection: result.collection ? ApiTestService.view(result.collection) : null,
        sources: result.sources,
      });
    }),
  );

  // ---------- Overload tests ----------

  router.get(
    '/load-tests/profiles',
    requireAuth,
    ...load('view'),
    wrap((request, response) => {
      const query = z
        .object({
          vus: z.coerce.number().int().min(1).max(2_000).default(20),
          durationSec: z.coerce
            .number()
            .int()
            .min(10)
            .max(4 * 3600)
            .default(300),
        })
        .parse(request.query);
      send(response, 200, {
        profiles: LOAD_PROFILE_TYPES.map((profile) =>
          ApiTestService.scenarioDefaults(profile, query.vus, query.durationSec),
        ),
      });
    }),
  );

  router.get(
    '/load-tests/scenarios',
    requireAuth,
    ...load('view'),
    wrap(async (request, response) => {
      send(response, 200, { scenarios: await service.listScenarios(context(request).workspaceId) });
    }),
  );

  router.post(
    '/load-tests/scenarios',
    requireAuth,
    ...load('edit'),
    wrap(async (request, response) => {
      const { workspaceId, actorId } = context(request);
      send(response, 201, {
        scenario: await service.saveScenario(workspaceId, actorId, request.body),
      });
    }),
  );

  router.get(
    '/load-tests/scenarios/:id',
    requireAuth,
    ...load('view'),
    wrap(async (request, response) => {
      send(response, 200, {
        scenario: await service.getScenario(
          context(request).workspaceId,
          parseParams(idParams, request).id,
        ),
      });
    }),
  );

  router.put(
    '/load-tests/scenarios/:id',
    requireAuth,
    ...load('edit'),
    wrap(async (request, response) => {
      const { workspaceId, actorId } = context(request);
      send(response, 200, {
        scenario: await service.saveScenario(
          workspaceId,
          actorId,
          request.body,
          parseParams(idParams, request).id,
        ),
      });
    }),
  );

  router.delete(
    '/load-tests/scenarios/:id',
    requireAuth,
    ...load('delete'),
    wrap(async (request, response) => {
      await service.deleteScenario(context(request).workspaceId, parseParams(idParams, request).id);
      send(response, 200, { success: true });
    }),
  );

  router.get(
    '/load-tests/scenarios/:id/k6',
    requireAuth,
    ...load('view'),
    wrap(async (request, response) => {
      const file = await service.exportK6(
        context(request).workspaceId,
        parseParams(idParams, request).id,
      );
      send(response, 200, file);
    }),
  );

  router.post(
    '/load-tests/runs',
    requireAuth,
    ...load('edit'),
    wrap(async (request, response) => {
      const { workspaceId, actorId } = context(request);
      const input = parseBody(
        z.object({
          scenarioId: z.string().trim().min(1).max(100),
          target,
          authorized: z.boolean().default(false),
        }),
        request,
      );
      send(response, 201, { run: await service.startLoadRun(workspaceId, actorId, input) });
    }),
  );

  router.get(
    '/load-tests/runs',
    requireAuth,
    ...load('view'),
    wrap(async (request, response) => {
      const query = z
        .object({
          scenarioId: z.string().max(100).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query);
      const runs = await service.listRuns(context(request).workspaceId, { kind: 'load', ...query });
      send(response, 200, { runs: runs.map(runSummary) });
    }),
  );

  router.get(
    '/load-tests/runs/:id',
    requireAuth,
    ...load('view'),
    wrap(async (request, response) => {
      send(response, 200, { run: await runOf(request, 'load') });
    }),
  );

  router.post(
    '/load-tests/runs/:id/cancel',
    requireAuth,
    ...load('edit'),
    wrap(async (request, response) => {
      const run = await runOf(request, 'load');
      send(response, 200, { run: await service.cancelRun(run.workspaceId, run.id) });
    }),
  );

  router.delete(
    '/load-tests/runs/:id',
    requireAuth,
    ...load('delete'),
    wrap(async (request, response) => {
      const run = await runOf(request, 'load');
      await service.deleteRun(run.workspaceId, run.id);
      send(response, 200, { success: true });
    }),
  );

  router.post(
    '/load-tests/generate/prepare',
    requireAuth,
    ...load('edit'),
    wrap(async (request, response) => {
      const value = context(request);
      send(response, 200, {
        brief: await service.prepareGeneration(
          value.workspaceId,
          value,
          generationInput(request, 'load'),
        ),
      });
    }),
  );

  router.post(
    '/load-tests/generate',
    requireAuth,
    ...load('edit'),
    wrap(async (request, response) => {
      const value = context(request);
      const result = await service.generate(
        value.workspaceId,
        value.actorId,
        value,
        generationInput(request, 'load'),
      );
      send(response, 201, { scenario: result.scenario ?? null, sources: result.sources });
    }),
  );

  // ---------- devkit runner (local runs) ----------

  // Only the user who started a local run can claim it, so membership is all a runner needs.
  const runnerAccess = (request: Request, _response: Response, next: (error?: unknown) => void) => {
    next(
      request.context?.memberRole
        ? undefined
        : new ApplicationError('FORBIDDEN', 'Workspace membership required.', 403),
    );
  };

  router.post(
    '/api-tests/runner/claim',
    requireAuth,
    runnerAccess,
    wrap(async (request, response) => {
      const { workspaceId, actorId } = context(request);
      const { runner, waitSeconds } = parseBody(
        z.object({
          runner: runnerFields,
          waitSeconds: z.number().int().min(0).max(25).default(20),
        }),
        request,
      );
      const signal = disconnectSignal(response);
      const deadline = Date.now() + waitSeconds * 1_000;
      const label = `${runner.name} (${runner.platform})`;
      let run = await service.claimLocal(workspaceId, actorId, { id: runner.id, label });
      while (!run && Date.now() < deadline && !signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        run = await service.claimLocal(workspaceId, actorId, { id: runner.id, label });
      }
      if (!run) return send(response, 200, { run: null });
      send(response, 200, {
        run: { id: run.id, kind: run.kind, name: run.name, payload: service.payloadOf(run) },
      });
    }),
  );

  router.post(
    '/api-tests/runner/runs/:id/heartbeat',
    requireAuth,
    runnerAccess,
    wrap(async (request, response) => {
      const { workspaceId, actorId } = context(request);
      const { runnerId, partial } = parseBody(
        z.object({ runnerId: runnerFields.shape.id, partial: z.unknown().optional() }),
        request,
      );
      const run = await service.ownedRun(workspaceId, actorId, parseParams(idParams, request).id);
      const status = await service.heartbeat(
        run.id,
        runnerId,
        (partial ?? undefined) as ApiRun['result'] | undefined,
      );
      send(response, 200, { status: status ?? 'cancelled' });
    }),
  );

  router.post(
    '/api-tests/runner/runs/:id/complete',
    requireAuth,
    runnerAccess,
    wrap(async (request, response) => {
      const { workspaceId, actorId } = context(request);
      const body = parseBody(
        z.object({
          runnerId: runnerFields.shape.id,
          status: z.enum(['passed', 'failed', 'error']),
          result: z.unknown().nullable(),
          error: z.string().max(20_000).nullable(),
        }),
        request,
      );
      const run = await service.ownedRun(workspaceId, actorId, parseParams(idParams, request).id);
      const saved = await service.finish(run.id, body.runnerId, {
        status: body.status,
        result: (body.result ?? null) as ApiRun['result'],
        error: body.error,
      });
      send(response, 200, { saved });
    }),
  );

  return router;
}
