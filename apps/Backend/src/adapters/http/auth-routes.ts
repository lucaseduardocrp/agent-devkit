import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import {
  createAccessTokenSchema,
  emailOnlySchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from '../../contracts/auth.js';
import type { AccessTokenService } from '../../modules/identity/application/access-tokens.js';
import type { AuthService } from '../../modules/identity/application/auth-service.js';
import type {
  OAuthProvider,
  OAuthProviderName,
} from '../../modules/identity/application/oauth-provider.js';
import { ApplicationError } from '../../shared/errors.js';
import { extractBearerToken } from './auth-middleware.js';
import { parseBody } from './validation.js';

export interface AuthRouterOptions {
  readonly oauthProviders?: readonly OAuthProvider[];
  readonly oauthStateSecret?: string;
  readonly frontendUrl?: string;
  readonly secureCookies?: boolean;
  readonly accessTokens?: AccessTokenService;
}

export function createAuthRouter(
  authService: AuthService,
  options: AuthRouterOptions = {},
): Router {
  const router = Router();
  const providers = new Map(
    options.oauthProviders?.map((provider) => [provider.name, provider]) ?? [],
  );

  router.get('/auth/options', (_request, response) => {
    response.status(200).json({ oauthProviders: [...providers.keys()] });
  });

  router.post('/auth/register', async (request, response, next) => {
    try {
      const input = parseBody(registerSchema, request);
      const result = await authService.register(input);
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/auth/password/forgot', async (request, response, next) => {
    try {
      const input = parseBody(emailOnlySchema, request);
      await authService.requestPasswordReset(input.email);
      response.status(202).json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/auth/password/reset', async (request, response, next) => {
    try {
      const input = parseBody(resetPasswordSchema, request);
      response
        .status(200)
        .json(await authService.resetPassword(input.email, input.code, input.password));
    } catch (error) {
      next(error);
    }
  });

  router.get('/auth/oauth/:provider/start', (request, response, next) => {
    try {
      const providerName = request.params['provider'] as OAuthProviderName;
      const provider = providers.get(providerName);
      if (!provider || !options.oauthStateSecret || !options.frontendUrl) {
        throw new ApplicationError('OAUTH_UNAVAILABLE', 'OAuth provider is not configured.', 503);
      }
      const nonce = randomBytes(24).toString('base64url');
      const state = signState(
        { provider: providerName, nonce, expiresAt: Date.now() + 10 * 60_000 },
        options.oauthStateSecret,
      );
      response.setHeader('Set-Cookie', oauthCookie(nonce, 600, options.secureCookies));
      response.redirect(302, provider.createAuthorizationUrl(state));
    } catch (error) {
      next(error);
    }
  });

  router.get('/auth/oauth/:provider/callback', async (request, response, next) => {
    try {
      const providerName = request.params['provider'] as OAuthProviderName;
      const provider = providers.get(providerName);
      if (!provider || !options.oauthStateSecret || !options.frontendUrl) {
        throw new ApplicationError('OAUTH_UNAVAILABLE', 'OAuth provider is not configured.', 503);
      }
      const code = typeof request.query['code'] === 'string' ? request.query['code'] : '';
      const state = typeof request.query['state'] === 'string' ? request.query['state'] : '';
      const parsed = verifyState(state, options.oauthStateSecret);
      const cookieNonce = readCookie(request.header('cookie'), 'oauth_state');
      if (
        !code ||
        parsed.provider !== providerName ||
        parsed.expiresAt < Date.now() ||
        !cookieNonce ||
        !safeEqual(parsed.nonce, cookieNonce)
      ) {
        throw new ApplicationError('INVALID_OAUTH_STATE', 'Invalid OAuth state.', 400);
      }
      const result = await authService.loginWithOAuth(await provider.exchangeCode(code));
      response.setHeader('Set-Cookie', oauthCookie('', 0, options.secureCookies));
      const destination = new URL(options.frontendUrl);
      destination.hash = new URLSearchParams({ oauth_token: result.token }).toString();
      response.redirect(302, destination.toString());
    } catch (error) {
      next(error);
    }
  });

  router.post('/auth/login', async (request, response, next) => {
    try {
      const input = parseBody(loginSchema, request);
      const result = await authService.login(input);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/auth/me', async (request, response, next) => {
    try {
      const token = extractBearerToken(request.header('authorization'));
      if (!token) {
        throw new ApplicationError('UNAUTHORIZED', 'Authentication token is required.', 401);
      }
      const user = await authService.getMe(token);
      response.status(200).json({ user });
    } catch (error) {
      next(error);
    }
  });

  /** Resolves the token owner; creating tokens requires an interactive session, not another token. */
  async function tokenOwner(authorization: string | undefined, requireSession: boolean) {
    const token = extractBearerToken(authorization);
    const authenticated = token ? await authService.authenticate(token) : null;
    if (!authenticated) {
      throw new ApplicationError('UNAUTHORIZED', 'Authentication token is required.', 401);
    }
    if (requireSession && authenticated.kind !== 'session') {
      throw new ApplicationError(
        'SESSION_TOKEN_REQUIRED',
        'Access tokens can only be created from a signed-in session.',
        403,
      );
    }
    if (!options.accessTokens) {
      throw new ApplicationError(
        'ACCESS_TOKENS_UNAVAILABLE',
        'Access tokens are not enabled.',
        503,
      );
    }
    return { userId: authenticated.user.id, accessTokens: options.accessTokens };
  }

  router.get('/auth/tokens', async (request, response, next) => {
    try {
      const { userId, accessTokens } = await tokenOwner(request.header('authorization'), false);
      response.status(200).json({ tokens: await accessTokens.list(userId) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/auth/tokens', async (request, response, next) => {
    try {
      const input = parseBody(createAccessTokenSchema, request);
      const { userId, accessTokens } = await tokenOwner(request.header('authorization'), true);
      response.status(201).json(await accessTokens.create(userId, input));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/auth/tokens/:id', async (request, response, next) => {
    try {
      const { userId, accessTokens } = await tokenOwner(request.header('authorization'), false);
      await accessTokens.revoke(userId, request.params.id);
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.post('/auth/logout', async (request, response, next) => {
    try {
      const token = extractBearerToken(request.header('authorization'));
      if (token) {
        await authService.logout(token);
      }
      response.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function signState(
  payload: { provider: string; nonce: string; expiresAt: number },
  secret: string,
): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyState(
  state: string,
  secret: string,
): { provider: string; nonce: string; expiresAt: number } {
  const [body = '', signature = ''] = state.split('.');
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(signature, expected))
    throw new ApplicationError('INVALID_OAUTH_STATE', 'Invalid OAuth state.', 400);
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      provider: string;
      nonce: string;
      expiresAt: number;
    };
  } catch {
    throw new ApplicationError('INVALID_OAUTH_STATE', 'Invalid OAuth state.', 400);
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readCookie(header: string | undefined, name: string): string | null {
  const pair = header
    ?.split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : null;
}

function oauthCookie(value: string, maxAge: number, secure = false): string {
  return `oauth_state=${value}; HttpOnly; SameSite=Lax; Path=/auth/oauth; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
