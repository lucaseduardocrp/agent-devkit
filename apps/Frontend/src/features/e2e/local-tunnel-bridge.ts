const BRIDGE_URL = 'http://127.0.0.1:8765';

export interface LocalTunnelInfo {
  readonly localUrl: string;
  readonly publicUrl: string;
  readonly accessClientId?: string;
  readonly accessClientSecret?: string;
}

/**
 * - `unreachable`: the helper is not running, or the browser blocked local network access.
 * - `origin_mismatch`: the helper was started with another `--origin`.
 * - `outdated`: the helper cannot route multiple local services.
 * - `failed`: the helper answered with an error, such as cloudflared not being installed.
 */
export type LocalHelperErrorCode = 'unreachable' | 'origin_mismatch' | 'outdated' | 'failed';

export class LocalHelperError extends Error {
  public constructor(
    public readonly code: LocalHelperErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LocalHelperError';
  }
}

async function bridgeRequest(
  path: string,
  init?: RequestInit,
): Promise<{ tunnel: LocalTunnelInfo | null }> {
  let response: Response;
  try {
    response = await fetch(`${BRIDGE_URL}${path}`, { ...init, cache: 'no-store' });
  } catch {
    throw new LocalHelperError('unreachable', 'Local tunnel helper is unavailable.');
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { code?: string; error?: string };
    throw new LocalHelperError(
      body.code === 'origin_mismatch' ? 'origin_mismatch' : 'failed',
      body.error || 'Local tunnel helper is unavailable.',
    );
  }
  return response.json() as Promise<{ tunnel: LocalTunnelInfo | null }>;
}

export const localTunnelBridge = {
  status: () => bridgeRequest('/status'),
  start: (url: string) =>
    bridgeRequest('/tunnel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }),
  stop: () => bridgeRequest('/tunnel', { method: 'DELETE' }),
};
