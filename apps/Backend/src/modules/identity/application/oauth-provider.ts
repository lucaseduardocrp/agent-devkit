export type OAuthProviderName = 'google' | 'github';

export interface OAuthProfile {
  readonly provider: OAuthProviderName;
  readonly providerUserId: string;
  readonly email: string;
  readonly name: string;
  readonly emailVerified: boolean;
}

export interface OAuthProvider {
  readonly name: OAuthProviderName;
  createAuthorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<OAuthProfile>;
}
