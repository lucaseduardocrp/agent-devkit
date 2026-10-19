import type { RequestContext } from '../../../shared/context.js';
import { ApplicationError } from '../../../shared/errors.js';

export function requireOwnerId(context: RequestContext): string {
  const ownerId = context.ownerId?.trim();
  if (!ownerId) {
    throw new ApplicationError('OWNER_CONTEXT_REQUIRED', 'Access denied.', 403);
  }
  return ownerId;
}
