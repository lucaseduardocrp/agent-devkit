import { Router } from 'express';
import { integrationCategorySchema, saveIntegrationSchema } from '../../contracts/integrations.js';
import type { IntegrationsService } from '../../modules/integrations/application/integrations-service.js';
import { DynamicProviderFactory } from '../../modules/integrations/application/dynamic-provider-factory.js';
import { requireOwnerId } from '../../modules/knowledge/application/ownership.js';
import { ApplicationError } from '../../shared/errors.js';
import type { RequestContext } from '../../shared/context.js';
import { parseBody } from './validation.js';
import type { RequestContextResolver } from './compatibility-routes.js';
import { requireModuleAccess } from './module-policy.js';

function parseIntegrationRouteParams(category: string, providerIdInput: string | undefined) {
  const parsedCategory = integrationCategorySchema.safeParse(category);
  if (!parsedCategory.success) {
    throw new ApplicationError(
      'INVALID_INTEGRATION_CATEGORY',
      'Invalid integration category.',
      400,
      [{ field: 'category' }],
    );
  }

  const providerId = providerIdInput?.trim();
  if (!providerId) {
    throw new ApplicationError('PROVIDER_ID_REQUIRED', 'Provider ID is required.', 400, [
      { field: 'providerId' },
    ]);
  }

  return { category: parsedCategory.data, providerId };
}

function requireIntegrationManagementPermission(context: RequestContext): void {
  requireOwnerId(context);
  requireModuleAccess(context, [{ module: 'integrations', operation: 'edit' }]);
}

export function createIntegrationsRouter(
  integrationsService: IntegrationsService,
  resolveRequestContext: RequestContextResolver,
  dynamicProviderFactory: DynamicProviderFactory = new DynamicProviderFactory(integrationsService),
): Router {
  const router = Router();

  router.get('/integrations', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      const ownerId = requireOwnerId(context);
      const list = await integrationsService.listIntegrations(ownerId);
      response.status(200).json(list);
    } catch (error) {
      next(error);
    }
  });

  router.get('/integrations/azure-devops/members', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      const ownerId = requireOwnerId(context);
      const result = await dynamicProviderFactory.getAzureDevOpsProjectMembers(
        ownerId,
        undefined,
        context.actorId,
        request.query.testOptions === 'true',
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.put('/integrations/:category/:providerId', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      requireIntegrationManagementPermission(context);
      const ownerId = requireOwnerId(context);

      const { category, providerId } = parseIntegrationRouteParams(
        request.params.category,
        request.params.providerId,
      );

      const input = parseBody(saveIntegrationSchema, request);
      const result = await integrationsService.saveIntegration(
        ownerId,
        category,
        providerId,
        input,
      );

      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/integrations/:category/:providerId', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      requireIntegrationManagementPermission(context);
      const ownerId = requireOwnerId(context);

      const { category, providerId } = parseIntegrationRouteParams(
        request.params.category,
        request.params.providerId,
      );

      const deleted = await integrationsService.deleteIntegration(ownerId, category, providerId);

      response.status(200).json({ success: true, deleted });
    } catch (error) {
      next(error);
    }
  });

  router.post('/integrations/:category/:providerId/test', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      requireIntegrationManagementPermission(context);
      const ownerId = requireOwnerId(context);

      const { category, providerId } = parseIntegrationRouteParams(
        request.params.category,
        request.params.providerId,
      );

      const body = request.body as
        { settings?: Record<string, unknown>; secret?: string } | undefined;
      const settings =
        body?.settings ??
        (await integrationsService.getIntegration(ownerId, category, providerId))?.settings ??
        {};
      const secret =
        body?.secret ??
        (await integrationsService.getDecryptedSecret(ownerId, category, providerId)) ??
        undefined;

      const result = await dynamicProviderFactory.testConnectivity(
        providerId,
        category,
        settings,
        secret,
        undefined,
        context.locale,
      );

      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
