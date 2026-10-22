import { Router, type Request, type Response } from 'express';
import {
  testPlanCreateSchema,
  testPlanSaveSchema,
  searchQuerySchema,
  webhookPayloadSchema,
} from '../../contracts/http.js';
import { parseAndNormalizeTestPlans } from '../../modules/testplans/domain/test-plan.js';
import {
  detectTestPlanLanguage,
  DeterministicTestPlanGenerator,
  type TestPlanGeneratorPort,
} from '../../modules/testplans/application/generate-test-plan.js';
import { serializeTestPlanCsv } from '../../modules/testplans/adapters/csv-test-plan-exporters.js';
import {
  InMemoryKnowledgeSearch,
  type KnowledgeSearchPort,
} from '../../modules/knowledge/application/knowledge-search.js';
import { parseBody, parseQuery } from './validation.js';
import { requireModuleAccess } from './module-policy.js';
import type { RequestContext } from '../../shared/context.js';
import { ApplicationError } from '../../shared/errors.js';
import { requireOwnerId } from '../../modules/knowledge/application/ownership.js';
import {
  createSavedTestPlan,
  keepCaseMetadata,
  withCaseIds,
  InMemorySavedTestPlanStore,
  type SavedTestPlan,
  type SavedTestPlanStore,
} from '../../modules/testplans/application/saved-test-plans.js';
import type { E2eArtifactStore } from '../../modules/e2e/application/artifact-store.js';
import { fileOwner, syncItemFilesSafely } from '../../modules/shared/attachment-files.js';
import {
  ImportTestCases,
  MAX_IMPORTED_CASES,
} from '../../modules/testplans/application/import-test-cases.js';
import {
  InMemoryTestSuiteStore,
  TestSuiteService,
  type TestSuiteStore,
} from '../../modules/testplans/application/test-suites.js';
import { PublishTestSuite } from '../../modules/testplans/application/publish-test-suite.js';
import type { DynamicProviderFactory } from '../../modules/integrations/application/dynamic-provider-factory.js';
import { z } from 'zod';
import {
  InMemoryFieldMappingStore,
  type FieldMappingStore,
} from '../../modules/field-mapping/field-mapping.js';
import type { TestManagementResolver } from '../../modules/test-management/application/test-management-provider.js';
import { isTestManagementProvider } from '../../modules/test-management/domain/test-run.js';
import { resolveFieldMapping, withFieldValues } from '../../modules/field-mapping/field-mapping.js';

/** Values filled in for template fields when publishing, keyed by destination field. */
const fieldValues = z
  .record(
    z.string().min(1),
    z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
  )
  .optional();

const search = new InMemoryKnowledgeSearch();
const generator = new DeterministicTestPlanGenerator();

export type RequestContextResolver = (
  request: Request,
  response: Response,
) => RequestContext | Promise<RequestContext>;

function getRequestContext(_request: Request, response: Response): RequestContext {
  const value = response.getHeader('x-request-id');
  return { requestId: typeof value === 'string' ? value : 'unknown' };
}

/** Files referenced by the cases of a saved test plan (scenarios and attachments). */
const planFiles = (plan: SavedTestPlan | null | undefined) => plan && plan.plans;

export function createCompatibilityRouter(
  searchPort: KnowledgeSearchPort = search,
  testPlanGenerator: TestPlanGeneratorPort = generator,
  resolveRequestContext: RequestContextResolver = getRequestContext,
  savedTestPlans: SavedTestPlanStore = new InMemorySavedTestPlanStore(),
  testSuites: TestSuiteStore = new InMemoryTestSuiteStore(),
  providerFactory?: DynamicProviderFactory,
  fieldMappings: FieldMappingStore = new InMemoryFieldMappingStore(),
  testManagement?: TestManagementResolver,
  attachmentStore?: E2eArtifactStore,
): Router {
  const router = Router();
  const syncPlanFiles = (
    workspaceId: string,
    id: string,
    previous: SavedTestPlan | null | undefined,
    next: SavedTestPlan | null | undefined,
  ) =>
    syncItemFilesSafely(
      attachmentStore,
      workspaceId,
      fileOwner('testplan', id),
      planFiles(previous),
      planFiles(next) ?? null,
    );
  const suites = new TestSuiteService(testSuites);
  const remoteId = z.string().regex(/^[1-9]\d*$/);
  const providerQuery = z.object({ providerId: z.string().trim().min(1) });
  const publishBody = providerQuery
    .extend({
      remotePlanId: remoteId.optional(),
      remoteParentSuiteId: remoteId.optional(),
      remoteSuiteId: remoteId.optional(),
      remoteSuiteName: z.string().trim().min(1).max(255).optional(),
      // Kind of the suite created; a requirement suite belongs to each work item.
      suiteKind: z.enum(['static', 'requirement']).optional(),
      // Remote work items (PBI, bug, task...) the published cases are linked to. `workItemId`
      // is the single-item form clients used before `workItemIds`.
      workItemId: remoteId.optional(),
      workItemIds: z.array(remoteId).max(50).optional(),
      templateId: z.string().uuid().optional(),
      fieldValues,
    })
    .refine((body) => !body.fieldValues || Boolean(body.templateId), {
      path: ['templateId'],
    })
    .refine(
      (body) => !(body.remoteParentSuiteId || body.remoteSuiteId) || Boolean(body.remotePlanId),
      {
        path: ['remotePlanId'],
      },
    )
    .refine((body) => !(body.remoteParentSuiteId && body.remoteSuiteId), {
      path: ['remoteSuiteId'],
    })
    .refine((body) => !body.remoteSuiteName || Boolean(body.remoteParentSuiteId), {
      path: ['remoteParentSuiteId'],
    })
    .refine(
      (body) =>
        body.suiteKind !== 'requirement' ||
        Boolean(body.workItemId) ||
        Boolean(body.workItemIds?.length),
      { path: ['workItemIds'] },
    )
    .refine((body) => body.suiteKind !== 'requirement' || !body.remoteSuiteId, {
      path: ['suiteKind'],
    });

  router.get('/TestPlan/publish/providers', async (request, response, next) => {
    try {
      const workspaceId = requireOwnerId(await resolveRequestContext(request, response));
      response.json({
        providers: (await providerFactory?.listTestSuiteProviders(workspaceId)) ?? [],
      });
    } catch (error) {
      next(error);
    }
  });
  router.get('/TestPlan/publish/fields', async (request, response, next) => {
    try {
      const workspaceId = requireOwnerId(await resolveRequestContext(request, response));
      const { providerId } = parseQuery(providerQuery, request);
      const provider = await providerFactory?.resolveTestSuitePublisher(workspaceId, providerId);
      if (!provider?.listCaseFields)
        throw new ApplicationError(
          'FIELD_MAPPING_UNSUPPORTED',
          'Provider does not expose Test Case fields.',
          400,
        );
      response.json({ fields: await provider.listCaseFields() });
    } catch (error) {
      next(error);
    }
  });
  const suiteCases = async (workspaceId: string, suiteId: string) => {
    if (!(await testSuites.find(suiteId, workspaceId)))
      throw new ApplicationError('TEST_SUITE_NOT_FOUND', 'Local test suite not found.', 404);
    const suites = await testSuites.list(workspaceId);
    const ids = new Set([suiteId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const suite of suites)
        if (suite.parentId && ids.has(suite.parentId) && !ids.has(suite.id)) {
          ids.add(suite.id);
          changed = true;
        }
    }
    const saved = [] as Awaited<ReturnType<SavedTestPlanStore['list']>>[number][];
    const count = await savedTestPlans.count(workspaceId);
    for (let offset = 0; offset < count; offset += 100)
      saved.push(...(await savedTestPlans.list(workspaceId, offset, 100)));
    return saved
      .filter((plan) => plan.suiteId && ids.has(plan.suiteId))
      .flatMap((plan) => plan.plans);
  };
  router.get('/TestPlan/suites/:id/field-sources', async (request, response, next) => {
    try {
      const workspaceId = requireOwnerId(await resolveRequestContext(request, response));
      const cases = await suiteCases(workspaceId, String(request.params['id']));
      const keys = new Set<string>();
      for (const testCase of cases) {
        const custom = testCase.metadata?.['customFields'];
        if (!custom || typeof custom !== 'object' || Array.isArray(custom)) continue;
        for (const [providerId, fields] of Object.entries(custom))
          if (fields && typeof fields === 'object' && !Array.isArray(fields))
            for (const key of Object.keys(fields as Record<string, unknown>))
              keys.add(`${providerId}\u0000${key}`);
      }
      response.json({
        sources: [...keys].map((value) => {
          const [providerId, key] = value.split('\u0000');
          return { providerId, key };
        }),
      });
    } catch (error) {
      next(error);
    }
  });
  router.post('/TestPlan/suites/:id/field-preview', async (request, response, next) => {
    try {
      const workspaceId = requireOwnerId(await resolveRequestContext(request, response));
      const body = parseBody(
        z.object({ providerId: z.string().min(1), templateId: z.string().uuid(), fieldValues }),
        request,
      );
      const { providerId } = body;
      const stored = await fieldMappings.get(workspaceId, body.templateId);
      if (!stored || stored.entityType !== 'test_case' || stored.providerId !== providerId)
        throw new ApplicationError(
          'FIELD_MAPPING_INVALID',
          'Template does not match this Test Case provider.',
          400,
        );
      const template = withFieldValues(stored, body.fieldValues);
      const provider = await providerFactory?.resolveTestSuitePublisher(workspaceId, providerId);
      if (!provider?.listCaseFields)
        throw new ApplicationError(
          'FIELD_MAPPING_UNSUPPORTED',
          'Provider does not expose Test Case fields.',
          400,
        );
      const fields = await provider.listCaseFields();
      const cases = await suiteCases(workspaceId, String(request.params['id']));
      const previews = cases.map((testCase) => ({
        title: testCase.title,
        values: resolveFieldMapping(testCase, template, fields),
      }));
      response.json({ count: previews.length, previews: previews.slice(0, 20) });
    } catch (error) {
      next(error);
    }
  });
  router.post('/TestPlan/import', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      const workspaceId = requireOwnerId(context);
      requireModuleAccess(context, [{ module: 'testplans', operation: 'edit' }]);
      const remote = z.string().trim().min(1).max(200);
      const body = parseBody(
        z.object({
          providerId: z.string().min(1),
          planId: remote,
          suiteId: remote.optional(),
          includeChildSuites: z.boolean().optional(),
          localSuiteId: z.string().uuid().optional(),
          caseIds: z.array(remote).min(1).max(MAX_IMPORTED_CASES).optional(),
        }),
        request,
      );
      if (!isTestManagementProvider(body.providerId))
        throw new ApplicationError('TEST_PROVIDER_INVALID', 'Unsupported test provider.', 400);
      if (!testManagement)
        throw new ApplicationError(
          'TEST_PROVIDER_NOT_CONFIGURED',
          'Test provider is not configured.',
          400,
        );
      const { providerId, ...input } = body;
      const result = await new ImportTestCases(savedTestPlans, testSuites, testManagement).import(
        workspaceId,
        { ...input, provider: providerId },
      );
      // `savedPlan` keeps the answer of the single-suite import older clients expect.
      response.status(201).json({ result, savedPlan: result.plans[0] });
    } catch (error) {
      next(error);
    }
  });

  router.get('/TestPlan/publish/plans', async (request, response, next) => {
    try {
      const workspaceId = requireOwnerId(await resolveRequestContext(request, response));
      const { providerId } = parseQuery(providerQuery, request);
      const provider = await providerFactory?.resolveTestSuitePublisher(workspaceId, providerId);
      if (!provider)
        throw new ApplicationError(
          'TEST_SUITE_PROVIDER_NOT_CONFIGURED',
          'Provedor de testes não configurado.',
          400,
        );
      response.json({ plans: await provider.listPlans() });
    } catch (error) {
      next(error);
    }
  });

  router.get('/TestPlan/publish/plans/:planId/suites', async (request, response, next) => {
    try {
      const workspaceId = requireOwnerId(await resolveRequestContext(request, response));
      const { providerId } = parseQuery(providerQuery, request);
      const planId = request.params.planId;
      if (!remoteId.safeParse(planId).success)
        throw new ApplicationError(
          'INVALID_REMOTE_PLAN_ID',
          'Identificador de Test Plan inválido.',
          400,
        );
      const provider = await providerFactory?.resolveTestSuitePublisher(workspaceId, providerId);
      if (!provider)
        throw new ApplicationError(
          'TEST_SUITE_PROVIDER_NOT_CONFIGURED',
          'Provedor de testes não configurado.',
          400,
        );
      response.json({ suites: await provider.listSuites(planId) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/TestPlan/suites/:id/push', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      const workspaceId = requireOwnerId(context);
      requireModuleAccess(context, [{ module: 'testplans', operation: 'edit' }]);
      const body = parseBody(publishBody, request);
      const fieldTemplate = body.templateId
        ? await fieldMappings.get(workspaceId, body.templateId)
        : null;
      if (
        body.templateId &&
        (!fieldTemplate ||
          fieldTemplate.entityType !== 'test_case' ||
          fieldTemplate.providerId !== body.providerId)
      )
        throw new ApplicationError(
          'FIELD_MAPPING_INVALID',
          'Template does not match this Test Case provider.',
          400,
        );
      if (!(await testSuites.find(request.params.id, workspaceId)))
        throw new ApplicationError('TEST_SUITE_NOT_FOUND', 'Suíte de testes não encontrada.', 404);
      const publisher = await providerFactory?.resolveTestSuitePublisher(
        workspaceId,
        body.providerId,
      );
      if (!publisher)
        throw new ApplicationError(
          'TEST_SUITE_PROVIDER_NOT_CONFIGURED',
          'Configure e ative a integração Azure DevOps com projeto e credenciais de escrita.',
          400,
        );
      const result = await new PublishTestSuite(testSuites, savedTestPlans).execute(
        workspaceId,
        request.params.id,
        publisher,
        {
          remotePlanId: body.remotePlanId,
          remoteParentSuiteId: body.remoteParentSuiteId,
          remoteSuiteId: body.remoteSuiteId,
          remoteSuiteName: body.remoteSuiteName,
          suiteKind: body.suiteKind,
          workItemIds:
            body.workItemId || body.workItemIds?.length
              ? [
                  ...new Set([
                    ...(body.workItemId ? [body.workItemId] : []),
                    ...(body.workItemIds ?? []),
                  ]),
                ]
              : undefined,
          ...(fieldTemplate
            ? { fieldTemplate: withFieldValues(fieldTemplate, body.fieldValues) }
            : {}),
        },
      );
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  /** Validates an explicit suite or falls back to the workspace default root "Test" suite. */
  async function resolveSuiteId(workspaceId: string, suiteId: string | undefined): Promise<string> {
    if (suiteId) {
      if (!(await testSuites.find(suiteId, workspaceId)))
        throw new ApplicationError('TEST_SUITE_NOT_FOUND', 'Suíte de testes não encontrada.', 404);
      return suiteId;
    }
    const defaultSuite =
      (await suites.list(workspaceId)).find((suite) => !suite.parentId && suite.name === 'Test') ??
      (await suites.create(workspaceId, 'Test'));
    return defaultSuite.id;
  }

  router.post('/TestPlan/brief', async (request, response, next) => {
    try {
      const input = parseBody(testPlanCreateSchema, request);
      const context = await resolveRequestContext(request, response);
      requireOwnerId(context);
      if (!testPlanGenerator.prepare)
        throw new ApplicationError(
          'TEST_PLAN_BRIEF_UNAVAILABLE',
          'The configured generator cannot prepare generation briefs.',
          501,
        );
      response.json(await testPlanGenerator.prepare(input, context));
    } catch (error) {
      next(error);
    }
  });

  router.post('/TestPlan', async (request, response, next) => {
    try {
      const input = parseBody(testPlanSaveSchema, request);
      const context = await resolveRequestContext(request, response);
      const workspaceId = requireOwnerId(context);
      const sample = input.plans
        .flatMap((plan) => [plan.title, ...plan.steps.map((step) => step.action)])
        .join(' ');
      const language =
        detectTestPlanLanguage(sample, context.locale) === 'English' ? 'en-US' : 'pt-BR';
      const plans = parseAndNormalizeTestPlans(JSON.stringify(input.plans), { language });
      const suiteId = await resolveSuiteId(workspaceId, input.suiteId);
      const savedPlan = await savedTestPlans.save(
        createSavedTestPlan(workspaceId, { ...input, suiteId }, plans),
      );
      await syncPlanFiles(workspaceId, savedPlan.id, null, savedPlan);
      const csv = serializeTestPlanCsv(plans, {
        platform: input.platformProvider,
        areaPath: input.areaPath,
        assignedTo: input.assignedTo,
      });
      response.status(201).json({ plans, csv, savedPlan });
    } catch (error) {
      next(error);
    }
  });

  router.post('/TestPlan/csv', async (request, response, next) => {
    try {
      const input = parseBody(
        testPlanSaveSchema.pick({
          plans: true,
          platformProvider: true,
          areaPath: true,
          assignedTo: true,
        }),
        request,
      );
      const context = await resolveRequestContext(request, response);
      requireOwnerId(context);
      const sample = input.plans
        .flatMap((plan) => [plan.title, ...plan.steps.map((step) => step.action)])
        .join(' ');
      const language =
        detectTestPlanLanguage(sample, context.locale) === 'English' ? 'en-US' : 'pt-BR';
      const plans = parseAndNormalizeTestPlans(JSON.stringify(input.plans), { language });
      const csv = serializeTestPlanCsv(plans, {
        platform: input.platformProvider,
        areaPath: input.areaPath,
        assignedTo: input.assignedTo,
      });
      response.type('text/csv').attachment(`TestPlans-${Date.now()}.csv`).send(csv);
    } catch (error) {
      next(error);
    }
  });

  router.post('/TestPlan/generate/csv', async (request, response, next) => {
    try {
      const input = parseBody(testPlanCreateSchema, request);
      const context = await resolveRequestContext(request, response);
      const result = await testPlanGenerator.generate(input, context);
      const plans = 'plans' in result && Array.isArray(result.plans) ? result.plans : [result];
      const csv = serializeTestPlanCsv(plans, {
        platform: input.platformProvider ?? input.format,
        areaPath: input.areaPath,
        assignedTo: input.assignedTo,
      });
      response.type('text/csv').attachment(`TestPlans-${Date.now()}.csv`).send(csv);
    } catch (error) {
      next(error);
    }
  });

  router.post('/TestPlan/generate', async (request, response, next) => {
    try {
      const input = parseBody(testPlanCreateSchema, request);
      const context = await resolveRequestContext(request, response);
      const result = await testPlanGenerator.generate(input, context);
      const plans = 'plans' in result && Array.isArray(result.plans) ? result.plans : [result];
      const csv = serializeTestPlanCsv(plans, {
        platform: input.platformProvider ?? input.format,
        areaPath: input.areaPath,
        assignedTo: input.assignedTo,
      });
      const suiteId = context.ownerId
        ? await resolveSuiteId(context.ownerId, input.suiteId ?? undefined)
        : undefined;
      const savedPlan = context.ownerId
        ? await savedTestPlans.save(
            createSavedTestPlan(context.ownerId, { ...input, suiteId }, plans),
          )
        : undefined;
      response.status(200).json({ plans, csv, ...(savedPlan ? { savedPlan } : {}) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/TestPlan', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      const workspaceId = requireOwnerId(context);
      const parsedPage = Number(request.query.page ?? 1);
      const parsedPageSize = Number(request.query.pageSize ?? 10);
      const page = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
      const pageSize =
        Number.isInteger(parsedPageSize) && parsedPageSize > 0 ? Math.min(parsedPageSize, 50) : 10;
      const [items, total] = await Promise.all([
        savedTestPlans.list(workspaceId, (page - 1) * pageSize, pageSize),
        savedTestPlans.count(workspaceId),
      ]);
      response.json({ items, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
    } catch (error) {
      next(error);
    }
  });

  router.put('/TestPlan/:id', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      const workspaceId = requireOwnerId(context);
      const existing = await savedTestPlans.find(request.params.id, workspaceId);
      if (!existing)
        throw new ApplicationError('TEST_PLAN_NOT_FOUND', 'Test Plan não encontrado.', 404);
      const body = request.body as Partial<typeof existing>;
      if (body.suiteId === null)
        throw new ApplicationError(
          'TEST_SUITE_REQUIRED',
          'Todo Test Plan deve pertencer a uma suÃ­te de testes.',
          400,
        );
      if (
        body.suiteId !== undefined &&
        body.suiteId !== null &&
        !(await testSuites.find(body.suiteId, workspaceId))
      ) {
        throw new ApplicationError('TEST_SUITE_NOT_FOUND', 'Suíte de testes não encontrada.', 404);
      }
      const updated = await savedTestPlans.save({
        ...existing,
        title:
          typeof body.title === 'string' && body.title.trim() ? body.title.trim() : existing.title,
        plans: Array.isArray(body.plans)
          ? withCaseIds(keepCaseMetadata(existing.plans, body.plans))
          : existing.plans,
        suiteId: body.suiteId ?? existing.suiteId,
        updatedAt: new Date().toISOString(),
      });
      await syncPlanFiles(workspaceId, existing.id, existing, updated);
      response.json(updated);
    } catch (error) {
      next(error);
    }
  });

  /* v8 ignore start -- suite endpoint behavior is validated in the browser integration flow. */
  router.get('/TestPlan/suites', async (request, response, next) => {
    try {
      response.json(
        await suites.list(requireOwnerId(await resolveRequestContext(request, response))),
      );
    } catch (error) {
      next(error);
    }
  });
  router.post('/TestPlan/suites', async (request, response, next) => {
    try {
      const workspaceId = requireOwnerId(await resolveRequestContext(request, response));
      const body = request.body as { name?: unknown; parentId?: unknown };
      if (typeof body.name !== 'string' || !body.name.trim())
        throw new ApplicationError('VALIDATION_ERROR', 'O nome da suíte é obrigatório.', 400);
      response
        .status(201)
        .json(
          await suites.create(
            workspaceId,
            body.name,
            typeof body.parentId === 'string' ? body.parentId : undefined,
          ),
        );
    } catch (error) {
      next(error);
    }
  });
  router.put('/TestPlan/suites/:id', async (request, response, next) => {
    try {
      const workspaceId = requireOwnerId(await resolveRequestContext(request, response));
      const body = request.body as { name?: unknown; parentId?: unknown };
      response.json(
        await suites.update(request.params.id, workspaceId, {
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
          ...(body.parentId === null || typeof body.parentId === 'string'
            ? { parentId: body.parentId }
            : {}),
        }),
      );
    } catch (error) {
      next(error);
    }
  });
  router.delete('/TestPlan/suites/:id', async (request, response, next) => {
    try {
      const workspaceId = requireOwnerId(await resolveRequestContext(request, response));
      // Sub-suites and their test plans go with the suite, and so do the plans' files.
      const allSuites = await testSuites.list(workspaceId);
      const suiteIds = new Set([request.params.id]);
      for (let grew = true; grew;) {
        grew = false;
        for (const suite of allSuites)
          if (suite.parentId && suiteIds.has(suite.parentId) && !suiteIds.has(suite.id)) {
            suiteIds.add(suite.id);
            grew = true;
          }
      }
      const plans = attachmentStore
        ? (
            await savedTestPlans.list(workspaceId, 0, await savedTestPlans.count(workspaceId))
          ).filter((plan) => Boolean(plan.suiteId && suiteIds.has(plan.suiteId)))
        : [];
      await suites.delete(request.params.id, workspaceId);
      for (const plan of plans) await syncPlanFiles(workspaceId, plan.id, plan, null);
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });
  /* v8 ignore stop */

  router.delete('/TestPlan/:id', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      const workspaceId = requireOwnerId(context);
      const existing = await savedTestPlans.find(request.params.id, workspaceId);
      if (!existing) {
        throw new ApplicationError('TEST_PLAN_NOT_FOUND', 'Test Plan não encontrado.', 404);
      }
      const deleted = await savedTestPlans.delete(request.params.id, workspaceId);
      if (!deleted) {
        throw new ApplicationError('TEST_PLAN_NOT_FOUND', 'Test Plan não encontrado.', 404);
      }
      await syncPlanFiles(workspaceId, existing.id, existing, null);
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.get('/TestPlan/search', async (request, response, next) => {
    try {
      const { prompt } = parseQuery(searchQuerySchema, request);
      const context = await resolveRequestContext(request, response);
      const chunks = await searchPort.search(prompt, context);
      if (chunks.length === 0) {
        response.status(204).send();
        return;
      }

      response.json(chunks);
    } catch (error) {
      next(error);
    }
  });

  // Declared after the static GET routes (/TestPlan/suites, /TestPlan/search) so it cannot shadow them.
  router.get('/TestPlan/:id', async (request, response, next) => {
    try {
      const workspaceId = requireOwnerId(await resolveRequestContext(request, response));
      const plan = await savedTestPlans.find(request.params.id, workspaceId);
      if (!plan)
        throw new ApplicationError('TEST_PLAN_NOT_FOUND', 'Test Plan não encontrado.', 404);
      response.json(plan);
    } catch (error) {
      next(error);
    }
  });

  router.post('/WikiWebhook/azure-devops', (request, response, next) => {
    try {
      parseBody(webhookPayloadSchema, request);
      response.status(200).json({ accepted: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
