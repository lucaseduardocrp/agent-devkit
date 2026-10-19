import { randomUUID } from 'node:crypto';
import type { AuthRepository } from '../../identity/application/auth-repository.js';
import { ApplicationError } from '../../../shared/errors.js';
import type { SupportedLocale } from '../../../shared/i18n.js';
import type {
  EffectiveAccess,
  PermissionGroupEntity,
  WorkspaceEntity,
  WorkspaceMemberEntity,
  WorkspacePermissions,
  WorkspaceRole,
} from '../domain/workspace-entity.js';
import {
  normalizeModuleAccess,
  resolveEffectiveAccess,
  uniformModuleAccess,
  WORKSPACE_PERMISSION_KEYS,
  type ModuleAccessMap,
  type WorkspacePermissionKey,
} from '../domain/permissions.js';
import type { UserWorkspaceMembership, WorkspaceRepository } from './workspace-repository.js';

export function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'workspace';
}

export interface PermissionGroupInput {
  readonly name?: string;
  readonly description?: string;
  readonly modules?: ModuleAccessMap;
  readonly memberIds?: readonly string[];
}

const defaultGroups: Record<
  SupportedLocale,
  readonly { name: string; description: string; modules: ModuleAccessMap }[]
> = {
  'pt-BR': [
    {
      name: 'Editores',
      description: 'Visualizar, criar/editar e excluir conteúdo; integrações somente leitura.',
      modules: { ...uniformModuleAccess('delete'), integrations: 'view' },
    },
    {
      name: 'Leitores',
      description: 'Somente visualização; sem acesso às integrações.',
      modules: normalizeModuleAccess({ ...uniformModuleAccess('view'), integrations: 'none' }),
    },
  ],
  'en-US': [
    {
      name: 'Editors',
      description: 'View, create/edit and delete content; integrations are read-only.',
      modules: { ...uniformModuleAccess('delete'), integrations: 'view' },
    },
    {
      name: 'Viewers',
      description: 'View only; no access to integrations.',
      modules: normalizeModuleAccess({ ...uniformModuleAccess('view'), integrations: 'none' }),
    },
  ],
};

function denied(permission: WorkspacePermissionKey): ApplicationError {
  return new ApplicationError(
    'WORKSPACE_PERMISSION_DENIED',
    `Workspace permission ${permission} is required.`,
    403,
    [{ permission }],
    { permission },
  );
}

/** Keeps only workspace permission flags; legacy keys are dropped once a member is edited. */
function normalizeWorkspacePermissions(raw: WorkspacePermissions): WorkspacePermissions {
  return Object.fromEntries(
    WORKSPACE_PERMISSION_KEYS.filter((key) => raw[key] === true).map((key) => [key, true]),
  );
}

export class WorkspaceService {
  public constructor(
    private readonly workspaceRepository: WorkspaceRepository,
    private readonly authRepository: AuthRepository,
  ) {}

  public async createWorkspace(
    userId: string,
    name: string,
    customSlug?: string,
    locale: SupportedLocale = 'pt-BR',
  ): Promise<UserWorkspaceMembership> {
    const trimmedName = this.validateName(name);
    const baseSlug = customSlug ? slugify(customSlug) : slugify(trimmedName);
    let finalSlug = baseSlug;
    let attempts = 0;

    while (await this.workspaceRepository.findBySlug(finalSlug)) {
      attempts++;
      finalSlug = `${baseSlug}-${randomUUID().slice(0, 4)}`;
      if (attempts > 5) {
        finalSlug = `${baseSlug}-${randomUUID()}`;
        break;
      }
    }

    const workspace = await this.workspaceRepository.createWorkspace({
      name: trimmedName,
      slug: finalSlug,
      ownerId: userId,
    });

    const member = await this.workspaceRepository.addMember({
      workspaceId: workspace.id,
      userId,
      role: 'ADMIN',
      permissions: {},
    });

    for (const group of defaultGroups[locale])
      await this.workspaceRepository.createGroup({
        workspaceId: workspace.id,
        ...group,
        memberIds: [],
      });

    return { workspace, member, access: await this.accessOf(member) };
  }

  public async listUserWorkspaces(userId: string): Promise<readonly UserWorkspaceMembership[]> {
    const memberships = await this.workspaceRepository.listUserWorkspaces(userId);
    return Promise.all(
      memberships.map(async (membership) => ({
        ...membership,
        access: await this.accessOf(membership.member),
      })),
    );
  }

  public async getWorkspace(workspaceId: string, userId: string): Promise<UserWorkspaceMembership> {
    const member = await this.requireMember(workspaceId, userId);
    const workspace = await this.workspaceRepository.findById(workspaceId);
    if (!workspace) {
      throw new ApplicationError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
    }

    return { workspace, member, access: await this.accessOf(member) };
  }

  public async renameWorkspace(
    workspaceId: string,
    actorUserId: string,
    name: string,
  ): Promise<WorkspaceEntity> {
    await this.requirePermission(workspaceId, actorUserId, 'editWorkspace');
    return this.workspaceRepository.renameWorkspace(workspaceId, this.validateName(name));
  }

  public async listMembers(
    workspaceId: string,
    actorUserId: string,
  ): Promise<readonly WorkspaceMemberEntity[]> {
    await this.requireMember(workspaceId, actorUserId);
    const [members, groups] = await Promise.all([
      this.workspaceRepository.listMembers(workspaceId),
      this.workspaceRepository.listGroups(workspaceId),
    ]);
    return members.map((member) => ({
      ...member,
      groupIds: groups.filter((group) => group.memberIds.includes(member.id)).map((g) => g.id),
    }));
  }

  public async addMemberByEmail(
    workspaceId: string,
    actorUserId: string,
    email: string,
    role: WorkspaceRole,
    permissions?: WorkspacePermissions,
    groupIds?: readonly string[],
  ): Promise<WorkspaceMemberEntity> {
    const actor = await this.requirePermission(workspaceId, actorUserId, 'addMembers');
    if (role === 'ADMIN' && actor.member.role !== 'ADMIN') throw denied('manageRoles');
    if (permissions && !actor.access.workspace.manageRoles) throw denied('manageRoles');
    if (groupIds?.length && !actor.access.workspace.manageGroups) throw denied('manageGroups');

    const normalizedEmail = email.toLowerCase().trim();
    const targetUser = await this.authRepository.findByEmail(normalizedEmail);
    if (!targetUser) {
      throw new ApplicationError(
        'USER_NOT_FOUND',
        'Usuário com este e-mail não encontrado na plataforma.',
        404,
      );
    }

    const existingMember = await this.workspaceRepository.findMember(workspaceId, targetUser.id);
    if (existingMember) {
      throw new ApplicationError(
        'MEMBER_ALREADY_EXISTS',
        'Usuário já é membro deste workspace.',
        409,
      );
    }

    const grantable = permissions ? this.grantable(actor.access, permissions) : {};
    const validGroupIds = await this.validateGroupIds(workspaceId, groupIds ?? []);
    const member = await this.workspaceRepository.addMember({
      workspaceId,
      userId: targetUser.id,
      role,
      permissions: grantable,
    });
    if (validGroupIds.length)
      await this.workspaceRepository.setMemberGroups(workspaceId, member.id, validGroupIds);
    return { ...member, groupIds: validGroupIds };
  }

  public async updateMember(
    workspaceId: string,
    actorUserId: string,
    memberId: string,
    role?: WorkspaceRole,
    permissions?: WorkspacePermissions,
    groupIds?: readonly string[],
  ): Promise<WorkspaceMemberEntity> {
    const actor = await this.requireMembership(workspaceId, actorUserId);
    if ((role || permissions) && !actor.access.workspace.manageRoles) throw denied('manageRoles');
    if (groupIds && !actor.access.workspace.manageGroups) throw denied('manageGroups');

    const targetMember = await this.workspaceRepository.findMemberById(memberId);
    if (!targetMember || targetMember.workspaceId !== workspaceId) {
      throw new ApplicationError('MEMBER_NOT_FOUND', 'Membro não encontrado neste workspace.', 404);
    }

    // Only administrators can grant administration or change an administrator.
    const touchesAdmin =
      (role === 'ADMIN' && targetMember.role !== 'ADMIN') ||
      (targetMember.role === 'ADMIN' && (role !== undefined || permissions !== undefined));
    if (touchesAdmin && actor.member.role !== 'ADMIN') throw denied('manageRoles');

    if (role && role !== 'ADMIN' && targetMember.role === 'ADMIN') {
      const adminCount = await this.workspaceRepository.countAdmins(workspaceId);
      if (adminCount <= 1) {
        throw new ApplicationError(
          'CANNOT_DEMOTE_LAST_ADMIN',
          'O workspace deve ter pelo menos um administrador.',
          400,
        );
      }
    }

    const updated =
      role || permissions
        ? await this.workspaceRepository.updateMember(memberId, {
            role,
            permissions: permissions ? this.grantable(actor.access, permissions) : undefined,
          })
        : targetMember;
    if (groupIds)
      await this.workspaceRepository.setMemberGroups(
        workspaceId,
        memberId,
        await this.validateGroupIds(workspaceId, groupIds),
      );
    const groups = await this.workspaceRepository.listGroups(workspaceId);
    return {
      ...updated,
      groupIds: groups.filter((group) => group.memberIds.includes(memberId)).map((g) => g.id),
    };
  }

  public async removeMember(
    workspaceId: string,
    actorUserId: string,
    memberId: string,
  ): Promise<void> {
    const actor = await this.requireMembership(workspaceId, actorUserId);

    const targetMember = await this.workspaceRepository.findMemberById(memberId);
    if (!targetMember || targetMember.workspaceId !== workspaceId) {
      throw new ApplicationError('MEMBER_NOT_FOUND', 'Membro não encontrado neste workspace.', 404);
    }

    const isSelfRemoval = targetMember.userId === actorUserId;
    if (!isSelfRemoval && !actor.access.workspace.removeMembers) throw denied('removeMembers');
    if (!isSelfRemoval && targetMember.role === 'ADMIN' && actor.member.role !== 'ADMIN')
      throw denied('manageRoles');

    if (targetMember.role === 'ADMIN') {
      const adminCount = await this.workspaceRepository.countAdmins(workspaceId);
      if (adminCount <= 1) {
        throw new ApplicationError(
          'CANNOT_REMOVE_LAST_ADMIN',
          'Não é possível remover o único administrador do workspace.',
          400,
        );
      }
    }

    await this.workspaceRepository.deleteMember(memberId);
  }

  public async deleteWorkspace(
    workspaceId: string,
    actorUserId: string,
    auditedDelete?: (id: string, remove: () => Promise<void>) => Promise<void>,
  ): Promise<void> {
    await this.requirePermission(workspaceId, actorUserId, 'deleteWorkspace');

    const workspace = await this.workspaceRepository.findById(workspaceId);
    if (!workspace) {
      throw new ApplicationError('WORKSPACE_NOT_FOUND', 'Workspace não encontrado.', 404);
    }

    if (auditedDelete)
      await auditedDelete(workspaceId, () => this.workspaceRepository.deleteWorkspace(workspaceId));
    else await this.workspaceRepository.deleteWorkspace(workspaceId);
  }

  public async listGroups(
    workspaceId: string,
    actorUserId: string,
  ): Promise<readonly PermissionGroupEntity[]> {
    await this.requireMember(workspaceId, actorUserId);
    return this.workspaceRepository.listGroups(workspaceId);
  }

  public async createGroup(
    workspaceId: string,
    actorUserId: string,
    input: PermissionGroupInput,
  ): Promise<PermissionGroupEntity> {
    await this.requirePermission(workspaceId, actorUserId, 'manageGroups');
    const name = this.validateGroupName(input.name ?? '');
    await this.ensureUniqueGroupName(workspaceId, name);
    return this.workspaceRepository.createGroup({
      workspaceId,
      name,
      description: input.description?.trim() ?? '',
      modules: normalizeModuleAccess(input.modules),
      memberIds: await this.validateMemberIds(workspaceId, input.memberIds ?? []),
    });
  }

  public async updateGroup(
    workspaceId: string,
    actorUserId: string,
    groupId: string,
    input: PermissionGroupInput,
  ): Promise<PermissionGroupEntity> {
    await this.requirePermission(workspaceId, actorUserId, 'manageGroups');
    await this.requireGroup(workspaceId, groupId);
    const name = input.name === undefined ? undefined : this.validateGroupName(input.name);
    if (name) await this.ensureUniqueGroupName(workspaceId, name, groupId);
    return this.workspaceRepository.updateGroup(groupId, {
      name,
      description: input.description?.trim(),
      modules: input.modules ? normalizeModuleAccess(input.modules) : undefined,
      memberIds: input.memberIds
        ? await this.validateMemberIds(workspaceId, input.memberIds)
        : undefined,
    });
  }

  public async deleteGroup(workspaceId: string, actorUserId: string, groupId: string) {
    await this.requirePermission(workspaceId, actorUserId, 'manageGroups');
    await this.requireGroup(workspaceId, groupId);
    await this.workspaceRepository.deleteGroup(groupId);
  }

  public async ensureDefaultWorkspace(user: {
    id: string;
    name: string;
    email: string;
  }): Promise<UserWorkspaceMembership> {
    const existing = await this.listUserWorkspaces(user.id);
    if (existing.length > 0 && existing[0]) {
      return existing[0];
    }

    const cleanName = user.name?.trim() || user.email.split('@')[0] || 'Meu';
    return this.createWorkspace(user.id, `${cleanName}'s Workspace`);
  }

  private async accessOf(member: WorkspaceMemberEntity): Promise<EffectiveAccess> {
    const groups =
      member.role === 'ADMIN' ? [] : await this.workspaceRepository.listGroups(member.workspaceId);
    return resolveEffectiveAccess(
      member.role,
      member.permissions,
      groups.filter((group) => group.memberIds.includes(member.id)),
    );
  }

  private async requireMember(workspaceId: string, userId: string): Promise<WorkspaceMemberEntity> {
    const member = await this.workspaceRepository.findMember(workspaceId, userId);
    if (!member) {
      throw new ApplicationError(
        'WORKSPACE_ACCESS_DENIED',
        'You are not a member of this workspace.',
        403,
      );
    }
    return member;
  }

  private async requireMembership(workspaceId: string, userId: string) {
    const member = await this.requireMember(workspaceId, userId);
    return { member, access: await this.accessOf(member) };
  }

  private async requirePermission(
    workspaceId: string,
    userId: string,
    permission: WorkspacePermissionKey,
  ) {
    const membership = await this.requireMembership(workspaceId, userId);
    if (!membership.access.workspace[permission]) throw denied(permission);
    return membership;
  }

  /** Members can only hand out workspace permissions they hold themselves. */
  private grantable(access: EffectiveAccess, requested: WorkspacePermissions) {
    const normalized = normalizeWorkspacePermissions(requested);
    for (const key of WORKSPACE_PERMISSION_KEYS)
      if (normalized[key] && !access.workspace[key]) throw denied(key);
    return normalized;
  }

  private async requireGroup(workspaceId: string, groupId: string) {
    const group = await this.workspaceRepository.findGroup(groupId);
    if (!group || group.workspaceId !== workspaceId)
      throw new ApplicationError('PERMISSION_GROUP_NOT_FOUND', 'Permission group not found.', 404);
    return group;
  }

  private async validateGroupIds(workspaceId: string, groupIds: readonly string[]) {
    const unique = [...new Set(groupIds)];
    for (const groupId of unique) await this.requireGroup(workspaceId, groupId);
    return unique;
  }

  private async validateMemberIds(workspaceId: string, memberIds: readonly string[]) {
    const members = new Set(
      (await this.workspaceRepository.listMembers(workspaceId)).map((member) => member.id),
    );
    const unique = [...new Set(memberIds)];
    if (unique.some((id) => !members.has(id)))
      throw new ApplicationError('MEMBER_NOT_FOUND', 'Membro não encontrado neste workspace.', 404);
    return unique;
  }

  private async ensureUniqueGroupName(workspaceId: string, name: string, exceptId?: string) {
    const groups = await this.workspaceRepository.listGroups(workspaceId);
    if (
      groups.some(
        (group) => group.id !== exceptId && group.name.toLowerCase() === name.toLowerCase(),
      )
    )
      throw new ApplicationError(
        'PERMISSION_GROUP_NAME_TAKEN',
        'A permission group with this name already exists.',
        409,
      );
  }

  private validateName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 100) {
      throw new ApplicationError(
        'INVALID_WORKSPACE_NAME',
        'Workspace name must be between 1 and 100 characters.',
        400,
      );
    }
    return trimmed;
  }

  private validateGroupName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 80)
      throw new ApplicationError(
        'INVALID_PERMISSION_GROUP',
        'Group name must be between 1 and 80 characters.',
        400,
      );
    return trimmed;
  }
}
