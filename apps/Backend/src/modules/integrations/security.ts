import { ApplicationError } from '../../shared/errors.js';

export function validateExternalUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApplicationError('INVALID_EXTERNAL_URL', 'External URL is invalid.', 400);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ApplicationError(
      'INVALID_EXTERNAL_URL',
      'External URL protocol is not allowed.',
      400,
    );
  }

  if (url.username || url.password) {
    throw new ApplicationError(
      'INVALID_EXTERNAL_URL',
      'External URL credentials are not allowed.',
      400,
    );
  }

  return url;
}

export class WebhookReplayGuard {
  private readonly eventIds = new Set<string>();

  public accept(eventId: string): boolean {
    if (!eventId.trim() || this.eventIds.has(eventId)) {
      return false;
    }

    this.eventIds.add(eventId);
    return true;
  }
}
