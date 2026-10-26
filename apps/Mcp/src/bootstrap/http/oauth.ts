import { randomUUID } from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  InvalidGrantError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { AdkApiError } from '../../api/http-client.js';
import { signInForClient, whoIs, type CredentialOptions } from '../../api/credentials.js';
import { Sealer, sha256 } from './sealed.js';

const REQUEST_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;

interface PendingAuthorization {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state?: string;
}

interface AuthorizationCode {
  readonly token: string;
  readonly client: string;
  readonly challenge: string;
  readonly redirectUri: string;
  readonly expiresAt: string | null;
  readonly nonce: string;
}

/** Registered clients are sealed into their own client_id: nothing to store or lose on restart. */
export class SealedClientsStore implements OAuthRegisteredClientsStore {
  public constructor(private readonly sealer: Sealer) {}

  public getClient(clientId: string): OAuthClientInformationFull | undefined {
    const client = this.sealer.unseal<Omit<OAuthClientInformationFull, 'client_id'>>(clientId);
    return client ? { ...client, client_id: clientId } : undefined;
  }

  public registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): OAuthClientInformationFull {
    const issuedAt = Math.floor(Date.now() / 1000);
    const sealed = this.sealer.seal({ ...client, client_id_issued_at: issuedAt });
    return { ...client, client_id: sealed, client_id_issued_at: issuedAt };
  }
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export function renderLoginPage(input: {
  request: string;
  clientName: string;
  error?: string;
}): string {
  const error = input.error ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to ADK</title>
<style>
body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{width:100%;max-width:380px;background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:24px}
h1{font-size:18px;margin:0 0 4px}p{font-size:13px;color:#aaa;margin:0 0 16px}
label{display:block;font-size:12px;margin:12px 0 4px}input{width:100%;box-sizing:border-box;padding:10px;border-radius:6px;border:1px solid #444;background:#111;color:#eee}
button{margin-top:16px;width:100%;padding:10px;border:0;border-radius:6px;background:#5aa9ff;color:#081624;font-weight:600;cursor:pointer}
hr{border:0;border-top:1px solid #333;margin:20px 0}.error{color:#ff8a8a}
</style></head><body><main>
<h1>Sign in to ADK · Entrar no ADK</h1>
<p><strong>${escapeHtml(input.clientName)}</strong> wants to access ADK on your behalf. It will act with your workspace permissions.</p>
${error}
<form method="post" action="/oauth/login">
<input type="hidden" name="request" value="${escapeHtml(input.request)}">
<label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="username">
<label for="password">Password / Senha</label><input id="password" name="password" type="password" autocomplete="current-password">
<hr><p>Google or GitHub account? Create an access token in ADK (Settings → Access tokens) and paste it here.</p>
<label for="token">Access token</label><input id="token" name="token" type="password" autocomplete="off" placeholder="adk_pat_...">
<button type="submit">Authorize · Autorizar</button>
</form></main></body></html>`;
}

/**
 * OAuth 2.1 authorization server for remote MCP connectors (for example claude.ai). The access
 * token handed to the client is an ADK personal access token, revocable from the web app.
 */
export class AdkOAuthProvider implements OAuthServerProvider {
  public readonly clientsStore: SealedClientsStore;
  private readonly requests: Sealer;
  private readonly codes: Sealer;
  private readonly usedCodes = new Map<string, number>();

  public constructor(
    secret: string,
    private readonly api: CredentialOptions,
  ) {
    this.clientsStore = new SealedClientsStore(new Sealer(secret, 'oauth-client'));
    this.requests = new Sealer(secret, 'oauth-request');
    this.codes = new Sealer(secret, 'oauth-code');
  }

  public authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const request = this.requests.seal(
      {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state,
      } satisfies PendingAuthorization,
      REQUEST_TTL_MS,
    );
    sendPage(
      res,
      200,
      renderLoginPage({ request, clientName: clientLabel(client) }),
      params.redirectUri,
    );
    return Promise.resolve();
  }

  /** Handles the login form posted by the authorization page. */
  public loginRouter(): Router {
    const router = express.Router();
    router.post(
      '/oauth/login',
      express.urlencoded({ extended: false, limit: '16kb' }),
      (req: Request, res: Response) => {
        void this.completeLogin(req, res);
      },
    );
    return router;
  }
  public challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    return Promise.resolve().then(() => this.readCode(client, authorizationCode).challenge);
  }

  public exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    return Promise.resolve().then(() => {
      const code = this.readCode(client, authorizationCode);
      if (redirectUri && redirectUri !== code.redirectUri) {
        throw new InvalidGrantError('redirect_uri does not match the authorization request.');
      }
      if (this.usedCodes.has(code.nonce)) {
        throw new InvalidGrantError('Authorization code already used.');
      }
      this.forgetExpiredCodes();
      this.usedCodes.set(code.nonce, Date.now() + CODE_TTL_MS);
      const expiresIn = code.expiresAt
        ? Math.max(0, Math.floor((new Date(code.expiresAt).getTime() - Date.now()) / 1000))
        : undefined;
      return {
        access_token: code.token,
        token_type: 'bearer',
        ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
      };
    });
  }

  public exchangeRefreshToken(): Promise<OAuthTokens> {
    return Promise.reject(
      new InvalidGrantError(
        'Refresh tokens are not issued; authorize again when the token expires.',
      ),
    );
  }

  public async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const user = await whoIs(this.api, token);
      return { token, clientId: user.id, scopes: [] };
    } catch {
      throw new InvalidTokenError('Invalid or expired ADK token.');
    }
  }

  private readCode(client: OAuthClientInformationFull, value: string): AuthorizationCode {
    const code = this.codes.unseal<AuthorizationCode>(value);
    if (!code || code.client !== sha256(client.client_id)) {
      throw new InvalidGrantError('Invalid or expired authorization code.');
    }
    return code;
  }

  private forgetExpiredCodes(): void {
    const now = Date.now();
    for (const [nonce, until] of this.usedCodes) if (until < now) this.usedCodes.delete(nonce);
  }

  private async completeLogin(req: Request, res: Response): Promise<void> {
    const form = (req.body ?? {}) as Record<string, string | undefined>;
    const request = this.requests.unseal<PendingAuthorization>(form['request'] ?? '');
    const client = request ? this.clientsStore.getClient(request.clientId) : undefined;
    if (!request || !client || !client.redirect_uris.includes(request.redirectUri)) {
      sendPage(
        res,
        400,
        '<p>This authorization request is invalid or expired. Start again from your MCP client.</p>',
      );
      return;
    }
    const retry = (status: number, error: string) =>
      sendPage(
        res,
        status,
        renderLoginPage({ request: form['request']!, clientName: clientLabel(client), error }),
        request.redirectUri,
      );

    try {
      const pasted = form['token']?.trim();
      let credential: { token: string; expiresAt: string | null };
      if (pasted) {
        await whoIs(this.api, pasted);
        credential = { token: pasted, expiresAt: null };
      } else if (form['email']?.trim() && form['password']) {
        credential = await signInForClient(this.api, {
          email: form['email'].trim(),
          password: form['password'],
          tokenName: `MCP connector: ${clientLabel(client)}`,
        });
      } else {
        retry(400, 'Enter your e-mail and password, or an access token.');
        return;
      }
      const code = this.codes.seal(
        {
          token: credential.token,
          client: sha256(client.client_id),
          challenge: request.codeChallenge,
          redirectUri: request.redirectUri,
          expiresAt: credential.expiresAt,
          nonce: randomUUID(),
        } satisfies AuthorizationCode,
        CODE_TTL_MS,
      );
      const target = new URL(request.redirectUri);
      target.searchParams.set('code', code);
      if (request.state) target.searchParams.set('state', request.state);
      res.redirect(302, target.toString());
    } catch (error) {
      if (error instanceof AdkApiError && [400, 401, 403].includes(error.status)) {
        retry(401, 'Invalid credentials. Check your e-mail and password or the access token.');
        return;
      }
      retry(502, 'ADK is unavailable right now. Try again in a moment.');
    }
  }
}

function clientLabel(client: OAuthClientInformationFull): string {
  return (client.client_name ?? 'An MCP client').slice(0, 80);
}

/** `form-action` also governs the redirect after the form post, so the client callback is allowed. */
function sendPage(res: Response, status: number, html: string, redirectUri?: string): void {
  const callback = redirectUri ? ` ${new URL(redirectUri).origin}` : '';
  res
    .status(status)
    .set({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${callback}; frame-ancestors 'none'; base-uri 'none'`,
      'referrer-policy': 'no-referrer',
    })
    .send(html);
}
