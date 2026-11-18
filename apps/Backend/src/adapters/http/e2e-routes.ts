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
import type { E2eEnvironmentService } from '../../modules/e2e/application/e2e-environments.js';
import {
  MAX_ENVIRONMENT_VARIABLES,
  EXPLORATION_CONTEXT_KINDS,
  MAX_EXPLORATION_CONTEXT,
  MAX_EXPLORATION_DESCRIPTION,
} from '../../modules/e2e/domain/e2e-insight.js';
import { MAX_EXPLORATION_CODE_LENGTH } from '../../modules/e2e/domain/e2e-exploration-code.js';
import {
  E2E_SCRIPT_KINDS,
  HOOK_KINDS,
  MAX_HOOK_INSTRUCTIONS_LENGTH,
  MAX_RESULT_NOTE_LENGTH,
  MAX_RUN_INSTRUCTIONS_LENGTH,
  MAX_SUCCESS_CRITERIA_LENGTH,
} from '../../modules/e2e/domain/e2e.js';
import { TEST_MANAGEMENT_PROVIDERS } from '../../modules/test-management/domain/test-run.js';
import { requireAuth, requireModulePermission } from './auth-middleware.js';
import type { RequestContextResolver } from './compatibility-routes.js';
import type { RequestContext } from '../../shared/context.js';
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
  environmentId: z.string().trim().min(1).max(100).nullable().optional(),
  accessClientId: z.string().trim().max(320).optional(),
  accessClientSecret: z.string().trim().max(500).optional(),
  clearAccessServiceToken: z.boolean().optional(),
  prd: z.string().trim().max(500_000).default(''),
  prdFileNames: z.array(z.string().trim().min(1).max(255)).max(20).optional(),
  /** The tests are planned and written from the Brain; a PRD is then optional. */
  useBrain: z.boolean().optional(),
  diff: z.string().max(500_000).optional(),
  instructions: z.string().trim().max(MAX_RUN_INSTRUCTIONS_LENGTH).optional(),
  repository: z.object({
    provider: z.enum(['github', 'azure_devops', 'local']),
    id: z.string().trim().min(1).max(200),
    branch: z.string().trim().min(1).max(250),
    path: z.string().trim().max(300).default(''),
  }),
});
/**
 * Editing a run starts nothing, so it needs no product document: it is context for the AI, and
 * the tests are written later, from the document asked for when the user generates them.
 */
const editFields = createFields;
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
const linkSavedFields = z.object({
  savedCase: z.object({ planId: remoteId, caseId: remoteId }).nullable(),
});
const newRunFields = createFields
  .extend({
    planning: z.enum(['server', 'host']).default('server'),
    // Runs that automate imported or saved cases, or use the Brain, need no product document.
    importCases: importFields.optional(),
    savedCases: savedCaseFields.optional(),
    reporting: reportingFields.nullable().optional(),
    // False only creates the run: nothing is explored or planned until the user asks.
    start: z.boolean().optional(),
  })
  // Only a run that starts planning or writing right away needs a source for its tests; one that
  // is just saved (`start: false`) gets it when the user generates the tests.
  .refine(
    (fields) =>
      fields.start === false ||
      fields.prd ||
      fields.useBrain ||
      fields.importCases ||
      fields.savedCases,
    {
      path: ['prd'],
      message:
        'A product document is required unless the Brain is used or test cases are imported.',
    },
  )
  .refine((fields) => !(fields.importCases && fields.savedCases), {
    path: ['savedCases'],
    message: 'Automate platform cases or saved cases, not both.',
  });
const generateFields = z
  .object({
    savedCases: savedCaseFields.optional(),
    /** A product document written for this planning: it replaces the run's PRD. */
    prd: z.string().trim().min(1).max(500_000).optional(),
    prdFileNames: z.array(z.string().trim().min(1).max(255)).max(20).optional(),
  })
  .refine((fields) => !(fields.prd && fields.savedCases), {
    path: ['savedCases'],
    message: 'Plan from a PRD or automate saved cases, not both.',
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
  provider: z.enum(['github', 'azure_devops', 'local']),
  repositoryId: z.string().trim().min(1).max(200),
});
const script = z.string().min(1).max(MAX_SCRIPT_LENGTH);
const scriptKind = z.enum(E2E_SCRIPT_KINDS).default('spec');
const scriptQuery = z.object({ kind: scriptKind });
// An empty Before Run or After Run turns it off; the service rejects an empty spec.
const scriptFields = z.object({ content: z.string().max(MAX_SCRIPT_LENGTH), kind: scriptKind });
const hookInstructionFields = z.object({
  kind: z.enum(HOOK_KINDS as ['beforeRun', 'afterRun']),
  instructions: z.string().max(MAX_HOOK_INSTRUCTIONS_LENGTH),
});
const explorationCodeFields = z.object({ code: z.string().max(MAX_EXPLORATION_CODE_LENGTH) });
const hook = z.string().max(MAX_SCRIPT_LENGTH).nullable().optional();
const briefFields = z.object({ refresh: z.boolean().default(false) });
const exploreFields = z.object({
  description: z.string().trim().max(MAX_EXPLORATION_DESCRIPTION).optional(),
  context: z
    .array(
      z.object({
        kind: z.enum(EXPLORATION_CONTEXT_KINDS),
        id: z.string().trim().min(1).max(600),
      }),
    )
    .max(MAX_EXPLORATION_CONTEXT)
    .optional(),
  agentId: z.string().trim().min(1).max(100).optional(),
});
const sourceExploreFields = z.object({
  environmentId: z.string().trim().min(1).max(100),
  agentId: z.string().trim().min(1).max(100).optional(),
  executionTarget: z.enum(['remote', 'local']).optional(),
});
const sourceDocumentationFields = z.object({
  overview: z.string().trim().min(1).max(40_000),
  areas: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        description: z.string().trim().max(2_000).default(''),
        flows: z
          .array(
            z.object({
              title: z.string().trim().min(1).max(200),
              description: z.string().trim().max(2_000).default(''),
              steps: z.array(z.string().trim().min(1).max(1_000)).max(30).default([]),
              pages: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
              origin: z.enum(['documented', 'discovered', 'both']),
            }),
          )
          .max(80),
      }),
    )
    .max(60),
  brainDocuments: z
    .array(z.object({ title: z.string().max(300), source: z.string().max(2_000) }))
    .max(100)
    .optional(),
});
const sourceImageParams = z.object({ page: z.coerce.number().int().min(1).max(999) });
const explorationListQuery = z.object({ creationId: z.string().trim().min(1).max(100).optional() });
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
        category: z.string().trim().max(60).nullable().optional(),
        steps: z.array(z.string().trim().min(1).max(1_000)).max(200).default([]),
        script,
        beforeRun: hook,
        afterRun: hook,
        externalCase: externalCaseFields.nullable().optional(),
        savedCase: z.object({ planId: remoteId, caseId: remoteId }).nullable().optional(),
      }),
    )
    .min(1)
    .max(MAX_E2E_TESTS),
});
const successCriteriaFields = z.object({
  criteria: z.string().max(MAX_SUCCESS_CRITERIA_LENGTH),
});
const testResultFields = z.object({
  /** "run" gives back the status the execution produced. */
  decision: z.enum(['passed', 'failed', 'run']),
  note: z.string().max(MAX_RESULT_NOTE_LENGTH).optional(),
});
const MAX_CASE_CHAT_MESSAGES = 40;
const MAX_CASE_CHAT_MESSAGE_LENGTH = 10_000;
const MAX_CASE_CHAT_IMAGES = 5;
const rerunTestFields = z.object({
  regenerate: z.boolean().default(false),
  /** How the user decides the test passes; kept on the test. */
  successCriteria: z.string().max(MAX_SUCCESS_CRITERIA_LENGTH).optional(),
  /** How to rewrite the spec; only used with regenerate. */
  instructions: z.string().max(MAX_HOOK_INSTRUCTIONS_LENGTH).optional(),
  useLastRun: z.boolean().optional(),
  /** Saved environment the test runs with; null goes back to the run's, omitted keeps it. */
  environmentId: z.string().trim().min(1).max(100).nullable().optional(),
});
const fixStepFields = z.object({
  /** What the user knows or wants about the step (Markdown, may hold images). */
  instructions: z.string().max(MAX_HOOK_INSTRUCTIONS_LENGTH).default(''),
});
const reviseCaseFields = z.object({
  /** The conversation so far; the last message is what the user just said. */
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(MAX_CASE_CHAT_MESSAGE_LENGTH),
      }),
    )
    .min(1)
    .max(MAX_CASE_CHAT_MESSAGES)
    .refine((messages) => messages.at(-1)?.role === 'user', {
      message: 'The last message must be the user’s.',
    }),
  /** The case as the user has it open, with or without unsaved changes. */
  testCase: z.object({
    title: z.string().trim().min(1).max(300),
    description: z.string().max(20_000),
    steps: z
      .array(z.object({ action: z.string().max(1_000), expectedResult: z.string().max(1_000) }))
      .max(100),
  }),
  /** Images uploaded as attachments that the AI looks at. */
  imageIds: z.array(z.string().uuid()).max(MAX_CASE_CHAT_IMAGES).optional(),
});
const executionFields = z.object({ executionTarget: z.enum(['remote', 'local']) });
const idParams = z.object({ id: z.string().min(1).max(100) });
const environmentFields = z.object({
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().trim().min(1).max(500),
  username: z.string().trim().max(320).optional(),
  password: z.string().max(500).optional(),
  variables: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(60),
        // Omitted for a variable that keeps its saved value.
        value: z.string().max(4_000).optional(),
      }),
    )
    .max(MAX_ENVIRONMENT_VARIABLES)
    .optional(),
});
const explorationImageParams = idParams.extend({
  page: z.union([z.literal('live'), z.coerce.number().int().min(1).max(999)]),
});
const explorationStepParams = idParams.extend({
  index: z.coerce.number().int().min(1).max(999),
});
const explorationVideoParams = idParams.extend({
  worker: z.coerce.number().int().min(1).max(16),
});
const trailImageParams = idParams.extend({
  kind: z.enum(['page', 'element']),
  index: z.coerce.number().int().min(1).max(999),
});

/** Images of a run that keeps changing (live frames) are never cached; the others briefly. */
function sendJpeg(
  response: { setHeader(name: string, value: string): unknown; end(body: Buffer): unknown },
  content: Buffer,
  cache: boolean,
): void {
  response.setHeader('content-type', 'image/jpeg');
  response.setHeader('content-length', String(content.byteLength));
  response.setHeader('cache-control', cache ? 'private, max-age=300' : 'no-store');
  response.end(content);
}

function workspaceId(request: Request): string {
  const id = request.context?.workspaceId;
  if (!id) throw new ApplicationError('WORKSPACE_REQUIRED', 'Workspace context is required.', 400);
  return id;
}

/** Who started the work: a local run's browser work goes to that user's runner. */
/** The language of the person asking: a run is reported back to them in it. */
function localeOf(request: Request): string | undefined {
  return request.context?.locale;
}

function actorId(request: Request): string | undefined {
  return request.context?.actorId;
}

/** What the router needs to tell whether the user's own computer can run a local run. */
export interface LocalRunnerPresence {
  hasOnlineRunner(context: RequestContext): Promise<boolean>;
}

export const NO_LOCAL_RUNNER_WARNING = {
  code: 'NO_LOCAL_RUNNER',
  message:
    'No local runner is online for you, so this run waits (up to five minutes) for one. On your computer run "devkit runner" (first time: "devkit login", then "devkit e2e setup").',
} as const;

export function createE2eRouter(
  service: E2eService,
  contextResolver?: RequestContextResolver,
  runners?: LocalRunnerPresence,
  environments?: E2eEnvironmentService,
) {
  const router = Router();
  /**
   * The answer for a run that was just started. A run meant for the user's computer waits for a
   * runner, so when none is connected the answer says so instead of leaving it queued silently.
   */
  const started = async (request: Request, creation: { executionTarget?: string }) => {
    if (creation.executionTarget !== 'local' || !runners) return { creation };
    const online = await runners.hasOnlineRunner(request.context!).catch(() => true);
    return online ? { creation } : { creation, warnings: [NO_LOCAL_RUNNER_WARNING] };
  };
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
      const { kind } = parseQuery(scriptQuery, request);
      response.json({ script: await service.getScript(workspaceId(request), id, kind) });
    } catch (error) {
      next(error);
    }
  });

  router.put('/e2e/tests/:id/script', requireAuth, write, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      const { content, kind } = parseBody(scriptFields, request);
      response.json({ script: await service.pushScript(workspaceId(request), id, content, kind) });
    } catch (error) {
      next(error);
    }
  });

  router.put(
    '/e2e/tests/:id/hook-instructions',
    requireAuth,
    write,
    async (request, response, next) => {
      try {
        const { id } = parseParams(idParams, request);
        const { kind, instructions } = parseBody(hookInstructionFields, request);
        response.json({
          test: await service.updateHookInstructions(workspaceId(request), id, kind, instructions),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    '/e2e/tests/:id/success-criteria',
    requireAuth,
    write,
    async (request, response, next) => {
      try {
        const { id } = parseParams(idParams, request);
        const { criteria } = parseBody(successCriteriaFields, request);
        response.json({
          test: await service.updateSuccessCriteria(workspaceId(request), id, criteria),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.put('/e2e/tests/:id/result', requireAuth, write, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      const { decision, note } = parseBody(testResultFields, request);
      response.json({ test: await service.setResult(workspaceId(request), id, decision, note) });
    } catch (error) {
      next(error);
    }
  });

  router.put(
    '/e2e/tests/:id/steps/:position/result',
    requireAuth,
    write,
    async (request, response, next) => {
      try {
        const { id, position } = parseParams(stepParams, request);
        const { decision, note } = parseBody(testResultFields, request);
        response.json({
          test: await service.setStepResult(workspaceId(request), id, position, decision, note),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post('/e2e/tests/:id/reevaluate', requireAuth, write, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      response.json({
        test: await service.reevaluate(workspaceId(request), id, localeOf(request)),
      });
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

  router.post(
    '/e2e/creations/:id/saved-cases',
    requireAuth,
    write,
    async (request, response, next) => {
      try {
        const { id } = parseParams(idParams, request);
        const input = parseBody(savedCaseFields, request);
        response.json({ result: await service.linkSavedCases(workspaceId(request), id, input) });
      } catch (error) {
        next(error);
      }
    },
  );

  router.put('/e2e/tests/:id/saved-case', requireAuth, write, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      const { savedCase } = parseBody(linkSavedFields, request);
      response.json({ test: await service.linkSavedCase(workspaceId(request), id, savedCase) });
    } catch (error) {
      next(error);
    }
  });

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
      response.status(202).json(await started(request, creation));
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
      const fields = parseBody(editFields, request);
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

  router.post(
    '/e2e/creations/:id/generate',
    requireAuth,
    write,
    async (request, response, next) => {
      try {
        const { id } = parseParams(idParams, request);
        const { savedCases, prd, prdFileNames } = parseBody(generateFields, request);
        response.status(202).json(
          await started(
            request,
            await service.generate(
              workspaceId(request),
              id,
              {
                ...(savedCases ? { savedCases } : {}),
                ...(prd ? { prd, prdFileNames: prdFileNames ?? [] } : {}),
              },
              actorId(request),
            ),
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.post('/e2e/creations/:id/run', requireAuth, write, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      response
        .status(202)
        .json(
          await started(
            request,
            await service.rerun(workspaceId(request), id, actorId(request), localeOf(request)),
          ),
        );
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
        response.json(
          await started(
            request,
            await service.setExecutionTarget(workspaceId(request), id, executionTarget),
          ),
        );
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
      const { regenerate, instructions, useLastRun, environmentId, successCriteria } = parseBody(
        rerunTestFields.default({ regenerate: false }),
        request,
      );
      response.status(202).json(
        await started(
          request,
          await service.rerunTest(
            workspaceId(request),
            id,
            regenerate,
            actorId(request),
            {
              ...(instructions === undefined ? {} : { instructions }),
              ...(useLastRun === undefined ? {} : { useLastRun }),
              ...(successCriteria === undefined ? {} : { successCriteria }),
            },
            environmentId,
            localeOf(request),
          ),
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  // Rewrites one failed step of the spec with the AI and runs the test again.
  router.post(
    '/e2e/tests/:id/steps/:position/fix',
    requireAuth,
    write,
    async (request, response, next) => {
      try {
        const { id, position } = parseParams(stepParams, request);
        const { instructions } = parseBody(fixStepFields, request);
        response
          .status(202)
          .json(
            await started(
              request,
              await service.fixTestStep(
                workspaceId(request),
                id,
                position,
                instructions,
                actorId(request),
                localeOf(request),
              ),
            ),
          );
      } catch (error) {
        next(error);
      }
    },
  );

  router.post('/e2e/tests/:id/fix-case', requireAuth, write, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      const { messages, testCase, imageIds } = parseBody(reviseCaseFields, request);
      response.json({
        revision: await service.reviseTestCase(
          workspaceId(request),
          id,
          { messages, testCase, ...(imageIds ? { imageIds } : {}) },
          localeOf(request),
        ),
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

  if (environments) {
    router.get('/e2e/environments', requireAuth, read, async (request, response, next) => {
      try {
        response.json({ environments: await environments.list(workspaceId(request)) });
      } catch (error) {
        next(error);
      }
    });

    router.post('/e2e/environments', requireAuth, write, async (request, response, next) => {
      try {
        const input = parseBody(environmentFields, request);
        response
          .status(201)
          .json({ environment: await environments.create(workspaceId(request), input) });
      } catch (error) {
        next(error);
      }
    });

    router.put('/e2e/environments/:id', requireAuth, write, async (request, response, next) => {
      try {
        const { id } = parseParams(idParams, request);
        const input = parseBody(environmentFields, request);
        response.json({
          environment: await environments.update(workspaceId(request), id, input),
        });
      } catch (error) {
        next(error);
      }
    });

    router.delete('/e2e/environments/:id', requireAuth, write, async (request, response, next) => {
      try {
        const { id } = parseParams(idParams, request);
        await environments.delete(workspaceId(request), id);
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    });
  }

  router.get(
    '/e2e/creations/:id/exploration',
    requireAuth,
    read,
    async (request, response, next) => {
      try {
        const { id } = parseParams(idParams, request);
        response.json({ exploration: await service.exploration(workspaceId(request), id) });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/e2e/creations/:id/exploration/code',
    requireAuth,
    read,
    async (request, response, next) => {
      try {
        const { id } = parseParams(idParams, request);
        response.json(await service.explorationCode(workspaceId(request), id));
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    '/e2e/creations/:id/exploration/code',
    requireAuth,
    write,
    async (request, response, next) => {
      try {
        const { id } = parseParams(idParams, request);
        const { code } = parseBody(explorationCodeFields, request);
        response.json(await service.saveExplorationCode(workspaceId(request), id, code));
      } catch (error) {
        next(error);
      }
    },
  );

  router.post('/e2e/creations/:id/explore', requireAuth, write, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      const { description, context, agentId } = parseBody(exploreFields.default({}), request);
      response.status(202).json({
        exploration: await service.explore(workspaceId(request), id, actorId(request), {
          ...(description ? { description } : {}),
          ...(context?.length ? { context } : {}),
          ...(agentId ? { agentId } : {}),
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/e2e/source', requireAuth, read, async (request, response, next) => {
    try {
      response.json(await service.source(workspaceId(request)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/e2e/source/explore', requireAuth, write, async (request, response, next) => {
    try {
      const exploration = await service.exploreSource(
        request.context!,
        parseBody(sourceExploreFields, request),
      );
      response.status(202).json({ exploration });
    } catch (error) {
      next(error);
    }
  });

  router.post('/e2e/source/document', requireAuth, write, async (request, response, next) => {
    try {
      response.status(202).json(await service.documentSource(request.context!));
    } catch (error) {
      next(error);
    }
  });

  router.get('/e2e/source/brief', requireAuth, read, async (request, response, next) => {
    try {
      response.json({ brief: await service.sourceBrief(request.context!) });
    } catch (error) {
      next(error);
    }
  });

  router.put('/e2e/source/documentation', requireAuth, write, async (request, response, next) => {
    try {
      const source = await service.saveSourceDocumentation(
        workspaceId(request),
        parseBody(sourceDocumentationFields, request),
      );
      response.json({ documentation: source.documentation });
    } catch (error) {
      next(error);
    }
  });

  router.get('/e2e/source/images/:page', requireAuth, read, async (request, response, next) => {
    try {
      const { page } = parseParams(sourceImageParams, request);
      sendJpeg(response, await service.sourceImage(workspaceId(request), page), true);
    } catch (error) {
      next(error);
    }
  });

  router.get('/e2e/explorations', requireAuth, read, async (request, response, next) => {
    try {
      const { creationId } = parseQuery(explorationListQuery, request);
      response.json({
        explorations: await service.explorationScripts(workspaceId(request), creationId),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/e2e/explorations/:id', requireAuth, read, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      response.json({ exploration: await service.explorationScript(workspaceId(request), id) });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/e2e/explorations/:id', requireAuth, write, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      await service.deleteExplorationScript(workspaceId(request), id);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get(
    '/e2e/creations/:id/exploration/videos/:worker',
    requireAuth,
    read,
    async (request, response, next) => {
      try {
        const { id, worker } = parseParams(explorationVideoParams, request);
        const video = await service.explorationVideo(workspaceId(request), id, worker);
        response.setHeader('content-type', video.mimeType);
        response.setHeader('content-length', String(video.content.byteLength));
        response.setHeader('cache-control', 'private, max-age=300');
        response.end(video.content);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/e2e/creations/:id/exploration/steps/:index',
    requireAuth,
    read,
    async (request, response, next) => {
      try {
        const { id, index } = parseParams(explorationStepParams, request);
        sendJpeg(
          response,
          await service.explorationImage(workspaceId(request), id, { step: index }),
          true,
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/e2e/creations/:id/exploration/images/:page',
    requireAuth,
    read,
    async (request, response, next) => {
      try {
        const { id, page } = parseParams(explorationImageParams, request);
        sendJpeg(
          response,
          await service.explorationImage(workspaceId(request), id, page),
          page !== 'live',
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/e2e/creations/:id/action-map',
    requireAuth,
    read,
    async (request, response, next) => {
      try {
        const { id } = parseParams(idParams, request);
        response.json({ map: await service.actionMap(workspaceId(request), id) });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/e2e/tests/:id/trail/:kind/:index',
    requireAuth,
    read,
    async (request, response, next) => {
      try {
        const { id, kind, index } = parseParams(trailImageParams, request);
        // A rerun replaces the trail, so its images are not cached either.
        sendJpeg(response, await service.trailImage(workspaceId(request), id, kind, index), false);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get('/e2e/tests/:id/live', requireAuth, read, async (request, response, next) => {
    try {
      const { id } = parseParams(idParams, request);
      sendJpeg(response, await service.liveFrame(workspaceId(request), id), false);
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
