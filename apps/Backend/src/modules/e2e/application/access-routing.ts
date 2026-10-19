/**
 * Pure helpers for reaching a target behind Cloudflare Access or the local tunnel gateway.
 * Kept free of backend dependencies so the local runner CLI can use the same code.
 */
export interface AccessServiceToken {
  readonly clientId: string;
  readonly clientSecret: string;
}

export function isLocalGatewayToken(token: AccessServiceToken | null | undefined): boolean {
  return Boolean(token?.clientId.startsWith('adk-local-'));
}

export function localGatewayUrl(url: URL, transportUrl: string): string {
  const encodedOrigin = Buffer.from(url.origin, 'utf8').toString('base64url');
  return new URL(
    `/_adk/local/${encodedOrigin}${url.pathname}${url.search}`,
    transportUrl,
  ).toString();
}

export function isLoopbackRequest(url: URL): boolean {
  return (
    ['http:', 'https:'].includes(url.protocol) &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())
  );
}

export function accessHeaders(
  token: AccessServiceToken | null | undefined,
): Record<string, string> {
  return token
    ? {
        'CF-Access-Client-Id': token.clientId,
        'CF-Access-Client-Secret': token.clientSecret,
      }
    : {};
}
