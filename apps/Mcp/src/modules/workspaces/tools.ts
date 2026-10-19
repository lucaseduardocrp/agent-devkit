import { z } from 'zod';
import { segment } from '../../api/http-client.js';
import type { McpModule } from '../../core/registry.js';
import { defineTool, json } from '../../core/tool.js';
import { id } from '../shared.js';

const role = z
  .enum(['ADMIN', 'MEMBER', 'INTEGRATOR', 'VIEWER'])
  .describe(
    'ADMIN has every permission. For the other roles, module access comes from permission groups and workspace actions from the member permissions.',
  );
const flag = z.boolean().optional();
const permissions = z
  .object({
    editWorkspace: flag,
    deleteWorkspace: flag,
    addMembers: flag,
    removeMembers: flag,
    manageRoles: flag,
    manageGroups: flag,
    manageCosts: flag,
  })
  .optional()
  .describe(
    'Workspace-level permissions of the member (actions on the workspace itself). Members can only grant permissions they hold.',
  );
const groupIds = z
  .array(id('Permission group id from workspaces_list_groups.'))
  .max(100)
  .optional()
  .describe('Permission groups of the member; replaces the current groups. Requires manageGroups.');
const level = z.enum(['none', 'view', 'edit', 'delete']).optional();
const modules = z
  .object({
    issues: level,
    pbis: level,
    agents: level,
    brain: level,
    design: level,
    specs: level,
    releaseNotes: level,
    testplans: level,
    e2e: level,
    integrations: level,
  })
  .describe(
    'Access per module. Levels are cumulative: edit includes view, delete includes edit. Omitted modules get no access.',
  );

const workspaceId = id('Workspace id. Defaults to the active workspace.').optional();

async function resolveWorkspace(
  explicit: string | undefined,
  state: () => Promise<{ workspaceId?: string }>,
) {
  const value = explicit ?? (await state()).workspaceId;
  if (!value) {
    throw new Error('No workspace selected. Call workspaces_list and then workspaces_select.');
  }
  return value;
}

export const workspacesModule: McpModule = {
  toolset: 'workspaces',
  tools: [
    defineTool({
      name: 'workspaces_list',
      title: 'List workspaces',
      description: 'Lists the workspaces the user belongs to, with the role in each.',
      toolset: 'workspaces',
      access: 'read',
      routes: ['GET /workspaces'],
      input: {},
      run: async (_input, { api, session }) =>
        json({
          activeWorkspaceId: (await session.state()).workspaceId ?? null,
          workspaces: await api.request({
            method: 'GET',
            path: '/workspaces',
            withoutWorkspace: true,
          }),
        }),
    }),
    defineTool({
      name: 'workspaces_select',
      title: 'Select workspace',
      description:
        'Sets the active workspace used by every other tool in this session (Brain, Specs, Test Plans, Agents, Design, Integrations).',
      toolset: 'workspaces',
      access: 'write',
      routes: [],
      input: { workspaceId: id('Workspace id from workspaces_list.') },
      run: async (input, { api, session }) => {
        const workspace = await api.request({
          method: 'GET',
          path: `/workspaces/${segment(input.workspaceId)}`,
          withoutWorkspace: true,
        });
        await session.update({ workspaceId: input.workspaceId });
        return json({ activeWorkspaceId: input.workspaceId, workspace });
      },
    }),
    defineTool({
      name: 'workspaces_get',
      title: 'Get workspace',
      description: 'Shows a workspace and the current user membership (role and permissions).',
      toolset: 'workspaces',
      access: 'read',
      routes: ['GET /workspaces/:id'],
      input: { workspaceId },
      run: async (input, { api, session }) =>
        json(
          await api.request({
            method: 'GET',
            path: `/workspaces/${segment(await resolveWorkspace(input.workspaceId, () => session.state()))}`,
            withoutWorkspace: true,
          }),
        ),
    }),
    defineTool({
      name: 'workspaces_create',
      title: 'Create workspace',
      description: 'Creates a workspace where the current user becomes ADMIN.',
      toolset: 'workspaces',
      access: 'write',
      routes: ['POST /workspaces'],
      input: {
        name: z.string().trim().min(1).max(100).describe('Workspace name.'),
        slug: z.string().trim().min(1).max(100).optional().describe('Optional URL slug.'),
      },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'POST',
            path: '/workspaces',
            body: input,
            withoutWorkspace: true,
          }),
        ),
    }),
    defineTool({
      name: 'workspaces_delete',
      title: 'Delete workspace',
      description:
        'Permanently deletes a workspace and all of its content. ADMIN only. Confirm with the user first.',
      toolset: 'workspaces',
      access: 'destructive',
      routes: ['DELETE /workspaces/:id'],
      input: { workspaceId: id('Workspace id to delete.') },
      run: async (input, { api, session }) => {
        const result = await api.request({
          method: 'DELETE',
          path: `/workspaces/${segment(input.workspaceId)}`,
          withoutWorkspace: true,
        });
        if ((await session.state()).workspaceId === input.workspaceId) {
          await session.update({ workspaceId: undefined });
        }
        return json(result);
      },
    }),
    defineTool({
      name: 'workspaces_list_members',
      title: 'List members',
      description: 'Lists the members of a workspace with their roles and permissions.',
      toolset: 'workspaces',
      access: 'read',
      routes: ['GET /workspaces/:id/members'],
      input: { workspaceId },
      run: async (input, { api, session }) =>
        json(
          await api.request({
            method: 'GET',
            path: `/workspaces/${segment(await resolveWorkspace(input.workspaceId, () => session.state()))}/members`,
            withoutWorkspace: true,
          }),
        ),
    }),
    defineTool({
      name: 'workspaces_add_member',
      title: 'Add member',
      description: 'Adds an existing ADK user to a workspace by e-mail.',
      toolset: 'workspaces',
      access: 'write',
      routes: ['POST /workspaces/:id/members'],
      input: { workspaceId, email: z.string().trim().email(), role, permissions, groupIds },
      run: async ({ workspaceId: explicit, ...body }, { api, session }) =>
        json(
          await api.request({
            method: 'POST',
            path: `/workspaces/${segment(await resolveWorkspace(explicit, () => session.state()))}/members`,
            body,
            withoutWorkspace: true,
          }),
        ),
    }),
    defineTool({
      name: 'workspaces_update_member',
      title: 'Update member',
      description: 'Changes the role, workspace permissions or permission groups of a member.',
      toolset: 'workspaces',
      access: 'write',
      routes: ['PATCH /workspaces/:id/members/:memberId'],
      input: {
        workspaceId,
        memberId: id('Member id from workspaces_list_members.'),
        role: role.optional(),
        permissions,
        groupIds,
      },
      run: async ({ workspaceId: explicit, memberId, ...body }, { api, session }) =>
        json(
          await api.request({
            method: 'PATCH',
            path: `/workspaces/${segment(await resolveWorkspace(explicit, () => session.state()))}/members/${segment(memberId)}`,
            body,
            withoutWorkspace: true,
          }),
        ),
    }),
    defineTool({
      name: 'workspaces_rename',
      title: 'Rename workspace',
      description: 'Renames a workspace. Requires the editWorkspace permission.',
      toolset: 'workspaces',
      access: 'write',
      routes: ['PATCH /workspaces/:id'],
      input: { workspaceId, name: z.string().trim().min(1).max(100) },
      run: async ({ workspaceId: explicit, name }, { api, session }) =>
        json(
          await api.request({
            method: 'PATCH',
            path: `/workspaces/${segment(await resolveWorkspace(explicit, () => session.state()))}`,
            body: { name },
            withoutWorkspace: true,
          }),
        ),
    }),
    defineTool({
      name: 'workspaces_list_groups',
      title: 'List permission groups',
      description:
        'Lists the permission groups of a workspace: the access each grants per module and the member ids in it.',
      toolset: 'workspaces',
      access: 'read',
      routes: ['GET /workspaces/:id/groups'],
      input: { workspaceId },
      run: async (input, { api, session }) =>
        json(
          await api.request({
            method: 'GET',
            path: `/workspaces/${segment(await resolveWorkspace(input.workspaceId, () => session.state()))}/groups`,
            withoutWorkspace: true,
          }),
        ),
    }),
    defineTool({
      name: 'workspaces_save_group',
      title: 'Save permission group',
      description:
        'Creates a permission group, or updates one when groupId is given. Members of the group get its module access. Requires manageGroups.',
      toolset: 'workspaces',
      access: 'write',
      routes: ['POST /workspaces/:id/groups', 'PATCH /workspaces/:id/groups/:groupId'],
      input: {
        workspaceId,
        groupId: id('Permission group id; omit to create a group.').optional(),
        name: z.string().trim().min(1).max(80).optional(),
        description: z.string().trim().max(500).optional(),
        modules: modules.optional(),
        memberIds: z
          .array(id('Member id from workspaces_list_members.'))
          .max(1000)
          .optional()
          .describe('Members of the group; replaces the current list.'),
      },
      run: async ({ workspaceId: explicit, groupId, ...body }, { api, session }) => {
        const base = `/workspaces/${segment(await resolveWorkspace(explicit, () => session.state()))}/groups`;
        return json(
          await api.request({
            method: groupId ? 'PATCH' : 'POST',
            path: groupId ? `${base}/${segment(groupId)}` : base,
            body,
            withoutWorkspace: true,
          }),
        );
      },
    }),
    defineTool({
      name: 'workspaces_delete_group',
      title: 'Delete permission group',
      description:
        'Deletes a permission group; its members lose the access it granted. Requires manageGroups.',
      toolset: 'workspaces',
      access: 'destructive',
      routes: ['DELETE /workspaces/:id/groups/:groupId'],
      input: { workspaceId, groupId: id('Permission group id from workspaces_list_groups.') },
      run: async ({ workspaceId: explicit, groupId }, { api, session }) =>
        json(
          await api.request({
            method: 'DELETE',
            path: `/workspaces/${segment(await resolveWorkspace(explicit, () => session.state()))}/groups/${segment(groupId)}`,
            withoutWorkspace: true,
          }),
        ),
    }),
    defineTool({
      name: 'workspaces_remove_member',
      title: 'Remove member',
      description: 'Removes a member from a workspace.',
      toolset: 'workspaces',
      access: 'destructive',
      routes: ['DELETE /workspaces/:id/members/:memberId'],
      input: { workspaceId, memberId: id('Member id from workspaces_list_members.') },
      run: async ({ workspaceId: explicit, memberId }, { api, session }) =>
        json(
          await api.request({
            method: 'DELETE',
            path: `/workspaces/${segment(await resolveWorkspace(explicit, () => session.state()))}/members/${segment(memberId)}`,
            withoutWorkspace: true,
          }),
        ),
    }),
  ],
};
