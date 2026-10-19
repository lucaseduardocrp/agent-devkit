import { z } from 'zod';
import { segment } from '../../api/http-client.js';
import type { McpModule } from '../../core/registry.js';
import { defineTool, json } from '../../core/tool.js';

const category = z
  .enum(['KNOWLEDGE', 'PROJECT_MANAGEMENT', 'LLM'])
  .describe('KNOWLEDGE (wikis), PROJECT_MANAGEMENT (boards) or LLM (model providers).');
const providerId = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe(
    'Provider id, e.g. azure_devops_wiki, github_projects, wiki_js, openai, anthropic, claude, gemini, groq, ollama.',
  );
const SECRET_NOTICE =
  'Secrets typed in chat are sent to the model provider; prefer configuring secrets in the ADK web app (Connect).';

const path = (input: { category: string; providerId: string }) =>
  `/integrations/${segment(input.category)}/${segment(input.providerId)}`;

export const integrationsModule: McpModule = {
  toolset: 'integrations',
  tools: [
    defineTool({
      name: 'integrations_list',
      title: 'List integrations',
      description: 'Lists the integrations of the active workspace (secrets are masked).',
      toolset: 'integrations',
      access: 'read',
      routes: ['GET /integrations'],
      input: {},
      run: async (_input, { api }) =>
        json(await api.request({ method: 'GET', path: '/integrations' })),
    }),
    defineTool({
      name: 'integrations_save',
      title: 'Save integration',
      description: `Creates or updates an integration (settings and optional secret). ${SECRET_NOTICE}`,
      toolset: 'integrations',
      access: 'write',
      routes: ['PUT /integrations/:category/:providerId'],
      input: {
        category,
        providerId,
        isEnabled: z.boolean().default(true),
        settings: z.record(z.string(), z.unknown()).default({}).describe('Provider settings.'),
        secret: z.string().optional().describe('API key or token; omit to keep the stored one.'),
      },
      run: async ({ category: c, providerId: p, ...body }, { api }) =>
        json(
          await api.request({ method: 'PUT', path: path({ category: c, providerId: p }), body }),
        ),
    }),
    defineTool({
      name: 'integrations_delete',
      title: 'Delete integration',
      description: 'Removes an integration and its stored secret from the active workspace.',
      toolset: 'integrations',
      access: 'destructive',
      routes: ['DELETE /integrations/:category/:providerId'],
      input: { category, providerId },
      run: async (input, { api }) =>
        json(await api.request({ method: 'DELETE', path: path(input) })),
    }),
    defineTool({
      name: 'integrations_test',
      openWorld: true,
      title: 'Test integration',
      description:
        'Tests connectivity of an integration, using the stored settings/secret unless overrides are given.',
      toolset: 'integrations',
      access: 'read',
      routes: ['POST /integrations/:category/:providerId/test'],
      input: {
        category,
        providerId,
        settings: z.record(z.string(), z.unknown()).optional(),
        secret: z.string().optional().describe(SECRET_NOTICE),
      },
      run: async ({ category: c, providerId: p, ...body }, { api }) =>
        json(
          await api.request({
            method: 'POST',
            path: `${path({ category: c, providerId: p })}/test`,
            body,
          }),
        ),
    }),
    defineTool({
      name: 'integrations_list_azure_members',
      openWorld: true,
      title: 'Azure DevOps members',
      description: 'Lists Azure DevOps project members (for example to assign test cases).',
      toolset: 'integrations',
      access: 'read',
      routes: ['GET /integrations/azure-devops/members'],
      input: {
        testOptions: z.boolean().optional().describe('Also return test assignment options.'),
      },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'GET',
            path: '/integrations/azure-devops/members',
            query: { testOptions: input.testOptions },
          }),
        ),
    }),
  ],
};
