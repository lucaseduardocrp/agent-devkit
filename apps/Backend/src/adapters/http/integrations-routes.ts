import { Router } from 'express';
import { z } from 'zod';
import {
  cliLoginCommand,
  createCliProfile,
  deleteCliProfile,
  listCliProfiles,
} from '../../modules/agents/adapters/cli-llm/cli-profiles.js';
import { integrationCategorySchema, saveIntegrationSchema } from '../../contracts/integrations.js';
import type { IntegrationsService } from '../../modules/integrations/application/integrations-service.js';
import { DynamicProviderFactory } from '../../modules/integrations/application/dynamic-provider-factory.js';
import { requireOwnerId } from '../../modules/knowledge/application/ownership.js';
import {
  bridgeEndpoint,
  llmCliTransport,
} from '../../modules/agents/adapters/cli-llm/cli-config.js';
import { detectCli, type CliStatus } from '../../modules/agents/adapters/cli-llm/cli-llm.js';
import { fetchBridgeClis } from '../../modules/agents/adapters/cli-llm/remote-cli-llm.js';
import { cliForProvider } from '../../modules/agents/adapters/cli-llm/cli-specs.js';
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
  detectProviderCli: typeof detectCli = detectCli,
  listBridgeClis: typeof fetchBridgeClis = fetchBridgeClis,
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

  // Which provider CLIs this server can use instead of an API key, and where they run: on the
  // machine of the API (`local`, ADK_LLM_CLI=true) or in the Bridge (`bridge`, per workspace).
  // Detection runs each CLI's own `--version`, so nothing is probed while CLIs are off.
  router.get('/integrations/llm/clis', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      const ownerId = requireOwnerId(context);
      const transport = llmCliTransport();
      if (!transport) {
        response.status(200).json({ enabled: false, providers: {} });
        return;
      }
      let statuses: readonly CliStatus[];
      let error: string | undefined;
      if (transport === 'bridge') {
        try {
          statuses = await listBridgeClis(bridgeEndpoint()!, ownerId);
        } catch (failure) {
          statuses = [];
          error = (failure as Error).message;
        }
      } else {
        statuses = await Promise.all(
          (['claude', 'codex', 'gemini'] as const).map((id) => detectProviderCli(id)),
        );
      }
      const providers: Record<string, unknown> = {};
      for (const providerId of ['claude', 'openai', 'gemini']) {
        const cli = cliForProvider(providerId);
        providers[providerId] = statuses.find((status) => status.id === cli);
      }
      response.status(200).json({
        enabled: true,
        transport,
        providers,
        // Whether the ADK's own tools can be offered to the CLI (ADK_MCP_URL is set).
        mcp: Boolean(process.env['ADK_MCP_URL']?.trim()),
        ...(error ? { error } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  // The accounts (login folders) of a provider CLI on the machine of the API. The ADK creates and
  // owns the folders, so a client only ever sends a name, never a path.
  const profilesOf = async (providerId: string, workspaceId: string) => {
    const cli = cliForProvider(providerId);
    if (!cli || llmCliTransport() !== 'local') return { cli: null, profiles: [] };
    const profiles = await listCliProfiles(workspaceId, cli);
    return {
      cli,
      profiles: profiles.map((profile) => ({
        name: profile.name,
        loginCommand: cliLoginCommand(cli, profile.path),
      })),
    };
  };

  router.get('/integrations/llm/:providerId/profiles', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      const ownerId = requireOwnerId(context);
      const { profiles } = await profilesOf(String(request.params.providerId), ownerId);
      response.status(200).json({ profiles });
    } catch (error) {
      next(error);
    }
  });

  router.post('/integrations/llm/:providerId/profiles', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      requireIntegrationManagementPermission(context);
      const ownerId = requireOwnerId(context);
      const cli = cliForProvider(String(request.params.providerId));
      if (!cli || llmCliTransport() !== 'local') {
        throw new ApplicationError(
          'LLM_CLI_PROFILES_UNSUPPORTED',
          'Separate CLI accounts are only available for Claude and Codex run on this machine.',
          400,
        );
      }
      const { name } = parseBody(z.object({ name: z.string().trim() }), request);
      const profile = await createCliProfile(ownerId, cli, name);
      response
        .status(201)
        .json({ name: profile.name, loginCommand: cliLoginCommand(cli, profile.path) });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/integrations/llm/:providerId/profiles/:name', async (request, response, next) => {
    try {
      const context = await resolveRequestContext(request, response);
      requireIntegrationManagementPermission(context);
      const ownerId = requireOwnerId(context);
      const cli = cliForProvider(String(request.params.providerId));
      if (!cli || llmCliTransport() !== 'local') {
        throw new ApplicationError(
          'LLM_CLI_PROFILES_UNSUPPORTED',
          'Separate CLI accounts are only available for Claude and Codex run on this machine.',
          400,
        );
      }
      await deleteCliProfile(ownerId, cli, String(request.params.name));
      response.status(204).end();
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
        ownerId,
      );

      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
