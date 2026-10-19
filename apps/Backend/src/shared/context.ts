import type {
  EffectiveAccess,
  WorkspacePermissions,
  WorkspaceRole,
} from '../modules/workspaces/domain/workspace-entity.js';
import type { SupportedLocale } from './i18n.js';

export interface RequestContext {
  readonly requestId: string;
  readonly actorId?: string;
  readonly actorName?: string;
  readonly actorEmail?: string;
  readonly ownerId?: string;
  readonly workspaceId?: string;
  readonly memberRole?: WorkspaceRole;
  readonly memberPermissions?: WorkspacePermissions;
  /** Effective module and workspace permissions of the member (groups included). */
  readonly access?: EffectiveAccess;
  readonly locale?: SupportedLocale;
  readonly signal?: AbortSignal;
  /** How the bearer token was issued; personal access tokens cannot manage other tokens. */
  readonly tokenKind?: 'session' | 'access-token';
  /** `read` tokens may only use safe HTTP methods. */
  readonly tokenScope?: 'full' | 'read';
}

export function createRequestContext(requestId: string, locale?: SupportedLocale): RequestContext {
  return { requestId, locale };
}
