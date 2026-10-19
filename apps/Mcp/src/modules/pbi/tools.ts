import { z } from 'zod';
import { segment } from '../../api/http-client.js';
import type { McpModule } from '../../core/registry.js';
import { defineTool, json } from '../../core/tool.js';
import { issueMutationResult, type IssueMutationResponse } from '../issues/host-run.js';
import { id, page, pageSize } from '../shared.js';

const itemId = id(
  'Internal PBI/card UUID, Azure DevOps work item number (e.g. 50086), or provider:externalId (e.g. azure_devops:50086).',
);
const providerId = z.enum(['azure_devops', 'trello', 'github_projects', 'jira']);
const linkType = z
  .enum([
    'parent',
    'child',
    'related',
    'predecessor',
    'successor',
    'duplicate',
    'duplicate_of',
    'tests',
    'tested_by',
  ])
  .describe('Link type seen from itemId, as in Azure DevOps "Add link" (e.g. child, related).');
const contractValues = z
  .record(z.string().max(100), z.string().max(500))
  .describe(
    'Values keyed by push contract field key, e.g. { "iterationPath": "Project\\Sprint 4" }.',
  );
const fields = {
  title: z.string().trim().min(1).max(240),
  description: z.string().max(30000).optional(),
  status: z.string().trim().min(1).max(100).optional(),
  parentId: itemId.nullable().optional(),
  position: z.number().finite().optional(),
};
export const pbiModule: McpModule = {
  toolset: 'pbi',
  tools: [
    defineTool({
      name: 'pbi_list',
      title: 'List PBIs and cards',
      description:
        'Searches the workspace backlog in pages. Filter by Azure DevOps work item number or iteration path (e.g. Sprint 191). Returns total and page metadata; use pbi_get with the returned ID for full detail.',
      toolset: 'pbi',
      access: 'read',
      routes: ['GET /pbi'],
      input: {
        externalId: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe('Exact provider work item ID, e.g. 50086.'),
        providerId: providerId.optional().describe('Provider for externalId, e.g. azure_devops.'),
        iterationPath: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .optional()
          .describe('Part of the iteration path, e.g. Sprint 191.'),
        page,
        pageSize: pageSize(100),
      },
      run: async (
        { externalId, providerId: provider, iterationPath, page: currentPage, pageSize: size },
        { api },
      ) =>
        json(
          await api.request({
            method: 'GET',
            path: '/pbi',
            query: {
              externalId,
              providerId: provider,
              iterationPath,
              page: currentPage ?? 1,
              pageSize: size ?? 25,
              compact: true,
            },
          }),
        ),
    }),
    defineTool({
      name: 'pbi_providers',
      title: 'List board providers',
      description: 'Lists configured board integrations available for pull and push.',
      toolset: 'pbi',
      access: 'read',
      routes: ['GET /pbi/providers'],
      input: {},
      run: async (_, { api }) => json(await api.request({ method: 'GET', path: '/pbi/providers' })),
    }),
    defineTool({
      name: 'pbi_current_iteration',
      title: 'Get current board iteration',
      description: 'Gets the current iteration from the connected board provider.',
      toolset: 'pbi',
      access: 'read',
      openWorld: true,
      routes: ['GET /pbi/current-iteration'],
      input: {},
      run: async (_, { api }) =>
        json(await api.request({ method: 'GET', path: '/pbi/current-iteration' })),
    }),
    defineTool({
      name: 'pbi_pull',
      title: 'Pull all boards',
      description:
        'Imports PBIs and cards from every connected board provider and returns per-provider counts without dumping the entire backlog.',
      toolset: 'pbi',
      access: 'write',
      routes: ['POST /pbi/pull'],
      input: {},
      run: async (_, { api }) =>
        json(
          await api.request({ method: 'POST', path: '/pbi/pull', query: { summaryOnly: true } }),
        ),
    }),
    defineTool({
      name: 'pbi_create',
      title: 'Create PBI or card',
      description: 'Creates a local backlog item. Cards can reference a parent PBI.',
      toolset: 'pbi',
      access: 'write',
      routes: ['POST /pbi/items'],
      input: { kind: z.enum(['pbi', 'card']), ...fields },
      run: async (body, { api }) =>
        json(await api.request({ method: 'POST', path: '/pbi/items', body })),
    }),
    defineTool({
      name: 'pbi_get',
      title: 'Get PBI item',
      description:
        'Gets a PBI or card by internal UUID, Azure DevOps number, or provider:externalId.',
      toolset: 'pbi',
      access: 'read',
      routes: ['GET /pbi/items/:id'],
      input: { itemId },
      run: async ({ itemId: target }, { api }) =>
        json(await api.request({ method: 'GET', path: `/pbi/items/${segment(target)}` })),
    }),
    defineTool({
      name: 'pbi_comments',
      title: 'Get PBI comments',
      description: 'Gets comments on a linked PBI or card from its board provider.',
      toolset: 'pbi',
      access: 'read',
      openWorld: true,
      routes: ['GET /pbi/items/:id/comments'],
      input: { itemId },
      run: async ({ itemId: target }, { api }) =>
        json(await api.request({ method: 'GET', path: `/pbi/items/${segment(target)}/comments` })),
    }),
    defineTool({
      name: 'pbi_sync_children',
      title: 'Sync child cards',
      description: 'Imports the latest child cards for a PBI from its linked board provider.',
      toolset: 'pbi',
      access: 'write',
      openWorld: true,
      routes: ['POST /pbi/items/:id/sync-children'],
      input: { itemId },
      run: async ({ itemId: target }, { api }) =>
        json(
          await api.request({
            method: 'POST',
            path: `/pbi/items/${segment(target)}/sync-children`,
          }),
        ),
    }),
    defineTool({
      name: 'pbi_context',
      title: 'Get PBI context',
      description: 'Gets a PBI or card together with descendants as context for an agent.',
      toolset: 'pbi',
      access: 'read',
      routes: ['GET /pbi/items/:id/context'],
      input: { itemId },
      run: async ({ itemId: target }, { api }) =>
        json(await api.request({ method: 'GET', path: `/pbi/items/${segment(target)}/context` })),
    }),
    defineTool({
      name: 'pbi_update',
      title: 'Update PBI item',
      description: 'Updates a local PBI or card.',
      toolset: 'pbi',
      access: 'write',
      routes: ['PATCH /pbi/items/:id'],
      input: {
        itemId,
        title: fields.title.optional(),
        description: fields.description,
        status: fields.status,
        parentId: fields.parentId,
        position: fields.position,
      },
      run: async ({ itemId: target, ...body }, { api }) =>
        json(await api.request({ method: 'PATCH', path: `/pbi/items/${segment(target)}`, body })),
    }),
    defineTool({
      name: 'pbi_delete',
      title: 'Delete PBI item',
      description: 'Deletes a local PBI or card and its children.',
      toolset: 'pbi',
      access: 'destructive',
      routes: ['DELETE /pbi/items/:id'],
      input: { itemId },
      run: async ({ itemId: target }, { api }) =>
        json(await api.request({ method: 'DELETE', path: `/pbi/items/${segment(target)}` })),
    }),
    defineTool({
      name: 'pbi_push_contract',
      title: 'Get push fields for a board',
      description:
        'Lists the fields required to push the item to a provider (Azure: work item type, iteration, area, assignee, state; GitHub: repository path, project, status, assignee; Trello: board, list, member; Jira: issue type, assignee, status) with their options and the values ADK mapped from the item. Fields with status "unresolved" could not be mapped and must be chosen. Pass chosen values back in `values` to reload dependent options (fields with reloadOnChange).',
      toolset: 'pbi',
      access: 'read',
      openWorld: true,
      routes: ['POST /pbi/items/:id/push-contract'],
      input: { itemId, providerId, values: contractValues.optional() },
      run: async ({ itemId: target, ...body }, { api }) =>
        json(
          await api.request({
            method: 'POST',
            path: `/pbi/items/${segment(target)}/push-contract`,
            body,
          }),
        ),
    }),
    defineTool({
      name: 'pbi_push',
      title: 'Push PBI item to board',
      description:
        'Creates or updates the item on a selected external board following the provider push contract: call pbi_push_contract first, confirm the values with the user and send them in `fields`. Push its parent first when needed. ADK links whose other item is already on the board are published too.',
      toolset: 'pbi',
      access: 'destructive',
      routes: ['POST /pbi/items/:id/push'],
      input: {
        itemId,
        providerId,
        fields: contractValues.optional(),
        boardId: z.string().optional(),
        listId: z.string().optional(),
        issueType: z.string().optional(),
      },
      run: async ({ itemId: target, ...body }, { api }) =>
        json(
          await api.request({ method: 'POST', path: `/pbi/items/${segment(target)}/push`, body }),
        ),
    }),
    defineTool({
      name: 'pbi_links',
      title: 'List PBI links',
      description:
        'Lists every link of a PBI or card: parent, children, links managed in ADK (related, predecessor/successor, duplicate, tests) and links read from Azure DevOps.',
      toolset: 'pbi',
      access: 'read',
      routes: ['GET /pbi/items/:id/relations'],
      input: { itemId },
      run: async ({ itemId: target }, { api }) =>
        json(await api.request({ method: 'GET', path: `/pbi/items/${segment(target)}/relations` })),
    }),
    defineTool({
      name: 'pbi_link',
      title: 'Link PBI items',
      description:
        'Links an item to one or more existing items. "child" moves the targets under the item and "parent" moves the item under the single target; the other types are N:N links.',
      toolset: 'pbi',
      access: 'write',
      routes: ['POST /pbi/items/:id/relations'],
      input: {
        itemId,
        type: linkType,
        targetIds: z
          .array(z.string().trim().min(1).max(200))
          .min(1)
          .max(50)
          .describe('Items to link: UUID, Azure DevOps number or provider:externalId.'),
      },
      run: async ({ itemId: target, ...body }, { api }) =>
        json(
          await api.request({
            method: 'POST',
            path: `/pbi/items/${segment(target)}/relations`,
            body,
          }),
        ),
    }),
    defineTool({
      name: 'pbi_unlink',
      title: 'Remove PBI link',
      description:
        'Removes one link between two items (removing a parent/child link moves the child to the root).',
      toolset: 'pbi',
      access: 'destructive',
      routes: ['DELETE /pbi/items/:id/relations/:type/:targetId'],
      input: { itemId, type: linkType, targetId: id('Linked item UUID.') },
      run: async ({ itemId: target, type, targetId }, { api }) =>
        json(
          await api.request({
            method: 'DELETE',
            path: `/pbi/items/${segment(target)}/relations/${segment(type)}/${segment(targetId)}`,
          }),
        ),
    }),
    defineTool({
      name: 'pbi_create_issue',
      title: 'Create issue from PBI item',
      description:
        'Creates an issue grounded in the PBI or card. If assigned to an agent, use the returned host brief and finish with issues_complete_run.',
      toolset: 'pbi',
      access: 'write',
      routes: ['POST /pbi/items/:id/issues'],
      input: {
        itemId,
        title: fields.title.optional(),
        assigneeAgentId: z.string().uuid().nullable().optional(),
      },
      run: async ({ itemId: target, ...body }, { api }) =>
        json(
          await issueMutationResult(
            api,
            await api.request<IssueMutationResponse>({
              method: 'POST',
              path: `/pbi/items/${segment(target)}/issues`,
              body: { ...body, runMode: 'host' },
            }),
          ),
        ),
    }),
  ],
};
