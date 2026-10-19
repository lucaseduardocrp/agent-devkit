import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApplicationError } from '../../shared/errors.js';
import { MAX_E2E_TESTS } from '../../modules/e2e/application/e2e-author.js';
import { probeTunnel } from '../../modules/e2e/application/tunnel-probe.js';
import {
  MAX_IMPORTED_CASES,
  MAX_SCRIPT_LENGTH,
  type E2eService,
} from '../../modules/e2e/application/e2e-service.js';
import { TEST_MANAGEMENT_PROVIDERS } from '../../modules/test-management/domain/test-run.js';
import { requireAuth, requireModulePermission } from './auth-middleware.js';
import type { RequestContextResolver } from './compatibility-routes.js';
import { parseBody, parseParams, parseQuery } from './validation.js';

const createFields = z.object({
  name: z.string().trim().min(1).max(120),
  agentId: z.string().trim().min(1).max(100),
  mode: z.enum(['frontend', 'backend']),
  scope: z.enum(['codebase', 'diff']).default('codebase'),
  baseUrl: z.string().trim().min(1).max(500),
  localOrigin: z.string().trim().max(500).optional(),
  executionTarget: z.enum(['remote', 'local']).optional(),
  path: z.string().trim().max(500).optional(),
  username: z.string().trim().max(320).optional(),
  password: z.string().max(500).optional(),
  accessClientId: z.string().trim().max(320).optional(),
  accessClientSecret: z.string().trim().max(500).optional(),
  clearAccessServiceToken: z.boolean().optional(),
  prd: z.string().trim().min(1).max(500_000),
  prdFileNames: z.array(z.string().trim().min(1).max(255)).max(20).optional(),
  diff: z.string().max(500_000).optional(),
  instructions: z.string().trim().max(5_000).optional(),
  repository: z.object({
    provider: z.enum(['github', 'azure_devops']),
    id: z.string().trim().min(1).max(200),
    branch: z.string().trim().min(1).max(250),
    path: z.string().trim().max(300).default(''),
  }),
});
const providerId = z.enum(TEST_MANAGEMENT_PROVIDERS);
const remoteId = z.string().trim().min(1).max(200);
const importFields = z.object({
  provider: providerId,
  planId: remoteId.optional(),
  suiteId: remoteId.optional(),
  caseIds: z.array(remoteId).min(1).max(MAX_IMPORTED_CASES).optional(),
});
const reportingFields = z.object({
  provider: providerId,
  planId: remoteId.nullable().optional(),
  suiteId: remoteId.nullable().optional(),
  autoPublish: z.boolean().default(true),
});
const savedCaseFields = z
  .object({
    suiteId: remoteId.optional(),
    planId: remoteId.optional(),
    caseIds: z.array(remoteId).min(1).max(MAX_IMPORTED_CASES).optional(),
  })
  .refine((fields) => fields.suiteId || fields.planId, {
    path: ['suiteId'],
    message: 'Choose a suite or a Test Plan.',
  });
const newRunFields = createFields
  .extend({
    planning: z.enum(['server', 'host']).default('server'),
    // Runs that automate imported or saved cases do not need a product document.
    prd: z.string().trim().max(500_000).default(''),
    importCases: importFields.optional(),
    savedCases: savedCaseFields.optional(),
    reporting: reportingFields.nullable().optional(),
  })
  .refine((fields) => fields.prd || fields.importCases || fields.savedCases, {
    path: ['prd'],
    message: 'A product document is required unless test cases are imported.',
  })
  .refine((fields) => !(fields.importCases && fields.savedCases), {
    path: ['savedCases'],
    message: 'Automate platform cases or saved cases, not both.',
  });
const externalCaseFields = z.object({
  provider: providerId,
  caseId: remoteId,
  planId: remoteId.optional(),
  suiteId: remoteId.optional(),
  title: z.string().trim().min(1).max(500),
  url: z.string().trim().max(2_000).optional(),
  steps: z
    .array(
      z.object({
        id: remoteId,
        action: z.string().max(10_000),
        expectedResult: z.string().max(10_000),
      }),
    )
    .max(200),
});
const linkFields = z.object({
  externalCase: z
    .object({
      provider: providerId,
      caseId: remoteId,
      planId: remoteId.optional(),
      suiteId: remoteId.optional(),
    })
    .nullable(),
});
const reportingBody = z.object({ reporting: reportingFields.nullable() });
const providerParams = z.object({ provider: providerId });
const suitesParams = providerParams.extend({ planId: remoteId });
const casesQuery = z.object({ planId: remoteId.optional(), suiteId: remoteId.optional() });
const stepParams = z.object({
  id: z.string().min(1).max(100),
  position: z.coerce.number().int().min(1).max(1_000),
});
const branchQuery = z.object({
  provider: z.enum(['github', 'azure_devops']),
  repositoryId: z.string().trim().min(1).max(200),
});
const script = z.string().min(1).max(MAX_SCRIPT_LENGTH);
const scriptFields = z.object({ content: script });
const briefFields = z.object({ refresh: z.boolean().default(false) });
const tunnelCheckFields = z.object({
  url: z.string().trim().min(1).max(500),
  creationId: z.string().trim().min(1).max(100).optional(),
  accessClientId: z.string().trim().max(320).optional(),
  accessClientSecret: z.string().trim().max(500).optional(),
});
const planFields = z.object({
  summary: z.string().trim().max(20_000).optional(),
  tests: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2_000).default(''),
        priority: z.enum(['high', 'medium', 'low']).default('medium'),
        steps: z.array(z.string().trim().min(1).max(1_000)).max(200).default([]),
        script,
        externalCase: externalCaseFields.nullable().optional(),
      }),
    )
    .min(1)
    .max(MAX_E2E_TESTS),
});
const rerunTestFields = z.object({ regenerate: z.boolean().default(false) });
const executionFields = z.object({ executionTarget: z.enum(['remote', 'local']) });
const idParams = z.object({ id: z.string().min(1).max(100) });

function workspaceId(request: Request): string {
  const id = request.context?.workspaceId;
  if (!id) throw new ApplicationError('WORKSPACE_REQUIRED', 'Workspace context is required.', 400);
  return id;
}

/** Who started the work: a local run's browser work goes to that user's runner. */
function actorId(request: Request): string | undefined {
  return request.context?.actorId;
}

export function createE2eRouter(service: E2eService, contextResolver?: RequestContextResolver) {
  const router = Router();
  const read = requireModulePermission('e2e', 'view');
  const write = requireModulePermission('e2e', 'edit');
  if (contextResolver)
    router.use('/e2e', async (request, response, next) => {
      try {
        request.context = await contextResolver(request, response);
        next();
      } catch (error) {
        next(error);
      }
    });

  router.post('/e2e/tunnel/check', requireAuth, write, async (request, response, next) => {
    try {
      const { url, creationId, accessClientId, accessClientSecret } = parseBody(
        tunnelCheckFields,
        request,
      );
      const saved =
        creationId && !accessClientId && !accessClientSecret
          ? await service.accessTokenForProbe(workspaceId(request), creationId, url)
          : null;
      response.json({
        result: await probeTunnel(url, undefined, undefined, {
          clientId: accessClientId ?? saved?.clientId,
          clientSecret: accessClientSecret ?? saved?.clientSecret,
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/e2e/repositories', requireAuth, read, async (request, response, next) => {
    try {
      response.json(await service.repositories(workspaceId(request)));
    } catch (error) {
      next(error);
    }
  });

  router.get('/e2e/repositories/branches', requireAuth, read, async (request, response, next) => {
    try {
      const { provider, repositoryId } = parseQuery(branchQuery, request);
      response.json({
        branches: await service.branches(workspaceId(request), provider, repositoryId),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/e2e/creations/:id/pull', requireAuth, write, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      response.json({ result: await service.pull(workspaceId(request), id) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/e2e/tests/:id/script', requireAuth, read, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      response.json({ script: await service.getScript(workspaceId(request), id) });
    } catch (error) {
      next(error);
    }
  });

  router.put('/e2e/tests/:id/script', requireAuth, write, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      const { content } = parseBody(scriptFields, request);
      response.json({ script: await service.pushScript(workspaceId(request), id, content) });
    } catch (error) {
      next(error);
    }
  });

  router.get(
    '/e2e/test-management/providers',
    requireAuth,
    read,
    async (request, response, next) => {
      try {
        response.json({ providers: await service.testManagementProviders(workspaceId(request)) });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/e2e/test-management/:provider/plans',
    requireAuth,
    read,
    async (request, response, next) => {
      try {
        const { provider } = parseParams(providerParams, request);
        response.json({ plans: await service.remotePlans(workspaceId(request), provider) });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/e2e/test-management/:provider/plans/:planId/suites',
    requireAuth,
    read,
    async (request, response, next) => {
      try {
        const { provider, planId } = parseParams(suitesParams, request);
        response.json({
          suites: await service.remoteSuites(workspaceId(request), provider, planId),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/e2e/test-management/:provider/cases',
    requireAuth,
    read,
    async (request, response, next) => {
      try {
        const { provider } = parseParams(providerParams, request);
        const location = parseQuery(casesQuery, request);
        response.json({
          cases: await service.remoteCases(workspaceId(request), provider, location),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/e2e/creations/:id/import-cases',
    requireAuth,
    write,
    async (request, response, next) => {
      try {
        const { id } = parseParams(idParams, request);
        const input = parseBody(importFields, request);
        response.json({ result: await service.importCases(workspaceId(request), id, input) });
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    '/e2e/creations/:id/reporting',
    requireAuth,
    write,
    async (request, response, next) => {
      try {
        const { id } = parseParams(idParams, request);
        const { reporting } = parseBody(reportingBody, request);
        response.json({
          creation: await service.setReporting(workspaceId(request), id, reporting),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post('/e2e/creations/:id/publish', requireAuth, write, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      response.status(202).json({ creation: await service.publish(workspaceId(request), id) });
    } catch (error) {
      next(error);
    }
  });

  router.put(
    '/e2e/tests/:id/external-case',
    requireAuth,
    write,
    async (request, response, next) => {
      try {
        const { id } = parseParams(idParams, request);
        const { externalCase } = parseBody(linkFields, request);
        response.json({ test: await service.linkCase(workspaceId(request), id, externalCase) });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/e2e/tests/:id/steps/:position/screenshot',
    requireAuth,
    read,
    async (request, response, next) => {
      try {
        const { id, position } = parseParams(stepParams, request);
        const content = await service.stepScreenshot(workspaceId(request), id, position);
        response.setHeader('content-type', 'image/png');
        response.setHeader('content-length', String(content.byteLength));
        response.setHeader('cache-control', 'private, max-age=60');
        response.end(content);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get('/e2e/creations', requireAuth, read, async (request, response, next) => {
    try {
      response.json({ creations: await service.list(workspaceId(request)) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/e2e/creations', requireAuth, write, async (request, response, next) => {
    try {
      const creation = await service.create(request.context!, parseBody(newRunFields, request));
      response.status(202).json({ creation });
    } catch (error) {
      next(error);
    }
  });

  router.get('/e2e/creations/:id', requireAuth, read, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      response.json({ creation: await service.get(workspaceId(request), id) });
    } catch (error) {
      next(error);
    }
  });

  router.put('/e2e/creations/:id', requireAuth, write, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      const fields = parseBody(createFields, request);
      response.json({ creation: await service.update(workspaceId(request), id, fields) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/e2e/creations/:id/brief', requireAuth, write, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      const { refresh } = parseBody(briefFields.default({ refresh: false }), request);
      response.json({
        brief: await service.brief(workspaceId(request), id, refresh, actorId(request)),
      });
    } catch (error) {
      next(error);
    }
  });

  router.put('/e2e/creations/:id/plan', requireAuth, write, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      const plan = parseBody(planFields, request);
      response.status(202).json({
        creation: await service.savePlan(workspaceId(request), id, plan, actorId(request)),
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/e2e/creations/:id', requireAuth, write, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      await service.delete(workspaceId(request), id);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post('/e2e/creations/:id/run', requireAuth, write, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      response
        .status(202)
        .json({ creation: await service.rerun(workspaceId(request), id, actorId(request)) });
    } catch (error) {
      next(error);
    }
  });

  router.put(
    '/e2e/creations/:id/execution',
    requireAuth,
    write,
    async (request, response, next) => {
      try {
        const { id } = parseParams(idParams, request);
        const { executionTarget } = parseBody(executionFields, request);
        response.json({
          creation: await service.setExecutionTarget(workspaceId(request), id, executionTarget),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post('/e2e/creations/:id/cancel', requireAuth, write, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      response.json({ creation: await service.cancel(workspaceId(request), id) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/e2e/tests/:id', requireAuth, read, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      response.json({ test: await service.getTest(workspaceId(request), id) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/e2e/tests/:id/run', requireAuth, write, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      const { regenerate } = parseBody(rerunTestFields.default({ regenerate: false }), request);
      response.status(202).json({
        creation: await service.rerunTest(workspaceId(request), id, regenerate, actorId(request)),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/e2e/tests/:id/video-url', requireAuth, read, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      response.json({ video: await service.videoUrl(workspaceId(request), id) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/e2e/tests/:id/video', requireAuth, read, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      const video = await service.video(workspaceId(request), id);
      response.setHeader('content-type', video.mimeType);
      response.setHeader('content-length', String(video.content.byteLength));
      response.setHeader('cache-control', 'private, max-age=60');
      response.end(video.content);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
