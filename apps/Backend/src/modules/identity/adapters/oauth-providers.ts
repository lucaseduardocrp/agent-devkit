import { ApplicationError } from '../../../shared/errors.js';
import type {
  OAuthProfile,
  OAuthProvider,
  OAuthProviderName,
} from '../application/oauth-provider.js';

interface OAuthProviderOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly callbackUrl: string;
}

function requireOk(response: Response, provider: string): Response {
  if (!response.ok) {
    throw new ApplicationError('OAUTH_FAILED', `${provider} authentication failed.`, 401);
  }
  return response;
}

export class GoogleOAuthProvider implements OAuthProvider {
  public readonly name: OAuthProviderName = 'google';

  public constructor(private readonly options: OAuthProviderOptions) {}

  public createAuthorizationUrl(state: string): string {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.options.clientId,
      redirect_uri: this.options.callbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    }).toString();
    return url.toString();
  }

  public async exchangeCode(code: string): Promise<OAuthProfile> {
    const tokenResponse = requireOk(
      await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
          redirect_uri: this.options.callbackUrl,
          grant_type: 'authorization_code',
        }),
      }),
      'Google',
    );
    const token = (await tokenResponse.json()) as { access_token: string };
    const profileResponse = requireOk(
      await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { authorization: `Bearer ${token.access_token}` },
      }),
      'Google',
    );
    const profile = (await profileResponse.json()) as {
      sub: string;
      email: string;
      email_verified?: boolean;
      name?: string;
    };
    return {
      provider: this.name,
      providerUserId: profile.sub,
      email: profile.email,
      name: profile.name || profile.email.split('@')[0] || 'Google user',
      emailVerified: profile.email_verified === true,
    };
  }
}

export class GitHubOAuthProvider implements OAuthProvider {
  public readonly name: OAuthProviderName = 'github';

  public constructor(private readonly options: OAuthProviderOptions) {}

  public createAuthorizationUrl(state: string): string {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({
      client_id: this.options.clientId,
      redirect_uri: this.options.callbackUrl,
      scope: 'read:user user:email',
      state,
    }).toString();
    return url.toString();
  }

  public async exchangeCode(code: string): Promise<OAuthProfile> {
    const tokenResponse = requireOk(
      await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
          code,
          redirect_uri: this.options.callbackUrl,
        }),
      }),
      'GitHub',
    );
    const token = (await tokenResponse.json()) as { access_token: string };
    const headers = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token.access_token}`,
      'user-agent': 'adk',
      'x-github-api-version': '2022-11-28',
    };
    const [userResponse, emailResponse] = await Promise.all([
      fetch('https://api.github.com/user', { headers }).then((response) =>
        requireOk(response, 'GitHub'),
      ),
      fetch('https://api.github.com/user/emails', { headers }).then((response) =>
        requireOk(response, 'GitHub'),
      ),
    ]);
    const user = (await userResponse.json()) as { id: number; name?: string; login: string };
    const emails = (await emailResponse.json()) as Array<{
      email: string;
      primary: boolean;
      verified: boolean;
    }>;
    const email = emails.find((item) => item.primary && item.verified);
    if (!email) {
      throw new ApplicationError(
        'OAUTH_EMAIL_REQUIRED',
        'A verified GitHub email is required.',
        422,
      );
    }
    return {
      provider: this.name,
      providerUserId: String(user.id),
      email: email.email,
      name: user.name || user.login,
      emailVerified: true,
    };
  }
}
