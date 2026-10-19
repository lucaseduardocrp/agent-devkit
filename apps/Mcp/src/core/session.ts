import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

/** Credentials and preferences of the person using the MCP server. */
export interface SessionState {
  /** API the token belongs to; a token is never sent to a different API. */
  readonly apiUrl?: string;
  readonly token?: string;
  readonly expiresAt?: string;
  readonly user?: SessionUser;
  readonly workspaceId?: string;
}

export interface SessionStore {
  read(): Promise<SessionState>;
  write(state: SessionState): Promise<void>;
  clear(): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  public constructor(private state: SessionState = {}) {}

  public read(): Promise<SessionState> {
    return Promise.resolve(this.state);
  }

  public write(state: SessionState): Promise<void> {
    this.state = state;
    return Promise.resolve();
  }

  public clear(): Promise<void> {
    this.state = {};
    return Promise.resolve();
  }
}

/** Persists the session in a user-only file (mode 0600), used by the local stdio server and CLI. */
export class FileSessionStore implements SessionStore {
  public constructor(private readonly path: string) {}

  public async read(): Promise<SessionState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  public async write(state: SessionState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await chmod(this.path, 0o600);
  }

  public async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

export interface SessionDefaults {
  readonly apiUrl: string;
  readonly token?: string;
  readonly workspaceId?: string;
}

/**
 * Resolves the effective credentials. Precedence for the token: a per-request token (for example
 * the `Authorization` header of the HTTP transport) > a stored login for the same API > the
 * `ADK_TOKEN` environment default.
 */
export class Session {
  public constructor(
    private readonly store: SessionStore,
    private readonly defaults: SessionDefaults,
  ) {}

  public async state(): Promise<SessionState> {
    const stored = await this.store.read();
    const sameApi = !stored.apiUrl || stored.apiUrl === this.defaults.apiUrl;
    return {
      apiUrl: this.defaults.apiUrl,
      token: (sameApi ? stored.token : undefined) ?? this.defaults.token,
      expiresAt: sameApi ? stored.expiresAt : undefined,
      user: sameApi ? stored.user : undefined,
      workspaceId: (sameApi ? stored.workspaceId : undefined) ?? this.defaults.workspaceId,
    };
  }

  public async update(patch: Partial<SessionState>): Promise<SessionState> {
    const current = await this.store.read();
    const base = current.apiUrl && current.apiUrl !== this.defaults.apiUrl ? {} : current;
    const next: SessionState = { ...base, ...patch, apiUrl: this.defaults.apiUrl };
    await this.store.write(next);
    return next;
  }

  public async clear(): Promise<void> {
    await this.store.clear();
  }
}
