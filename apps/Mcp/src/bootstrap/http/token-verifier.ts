import { AdkApiError } from '../../api/http-client.js';
import { whoIs, type AdkUser, type CredentialOptions } from '../../api/credentials.js';
import { sha256 } from './sealed.js';

/**
 * Checks bearer tokens against ADK (`GET /auth/me`) with a short cache, so the MCP endpoint can
 * answer 401 (and trigger client re-authentication) instead of failing inside every tool call.
 */
export class TokenVerifier {
  private readonly cache = new Map<string, { user: AdkUser | null; until: number }>();

  public constructor(
    private readonly options: CredentialOptions,
    private readonly ttlMs = 60_000,
    private readonly maxEntries = 1000,
  ) {}

  /** Returns the user, null for a rejected token; transient API failures are rethrown. */
  public async verify(token: string): Promise<AdkUser | null> {
    const key = sha256(token);
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) return cached.user;
    let user: AdkUser | null;
    try {
      user = await whoIs(this.options, token);
    } catch (error) {
      if (!(error instanceof AdkApiError) || error.status !== 401) throw error;
      user = null;
    }
    if (this.cache.size >= this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { user, until: Date.now() + this.ttlMs });
    return user;
  }
}
