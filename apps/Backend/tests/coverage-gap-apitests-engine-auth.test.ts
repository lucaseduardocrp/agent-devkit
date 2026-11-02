import { describe, expect, it } from 'vitest';
import {
  authorizeRequest,
  sendAuthorized,
  type AuthContext,
} from '../src/modules/apitests/engine/auth.js';
import type {
  HttpRequestInit,
  HttpResponseData,
} from '../src/modules/apitests/engine/http-transport.js';
import type { RequestAuth } from '../src/modules/apitests/engine/types.js';

function response(
  status: number,
  body = '',
  headers: (readonly [string, string])[] = [],
): HttpResponseData {
  const buffer = Buffer.from(body);
  return {
    status,
    statusText: '',
    headers,
    body: buffer,
    sizeBytes: buffer.length,
    truncated: false,
    url: '',
    httpVersion: '1.1',
    redirects: [],
    timings: { total: 1 },
  };
}

const header = (init: HttpRequestInit, name: string) =>
  init.headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

function context(
  send: (init: HttpRequestInit) => HttpResponseData,
  extra: Partial<AuthContext> = {},
): AuthContext & { readonly calls: HttpRequestInit[] } {
  const calls: HttpRequestInit[] = [];
  return {
    calls,
    cache: new Map(),
    send: (init) => {
      calls.push(init);
      return Promise.resolve(send(init));
    },
    ...extra,
  };
}

const get = (url: string, headers: (readonly [string, string])[] = []): HttpRequestInit => ({
  method: 'GET',
  url: new URL(url),
  headers,
});

const oauth2 = (extra: Partial<Extract<RequestAuth, { type: 'oauth2' }>> = {}) =>
  ({
    type: 'oauth2',
    grantType: 'client_credentials',
    accessTokenUrl: 'https://id.test/token',
    clientId: 'id',
    clientSecret: 'secret',
    ...extra,
  }) satisfies RequestAuth;

describe('nonces and timestamps with no injected clock', () => {
  it('makes its own nonce for digest and for edgegrid', async () => {
    const challenge = 'Digest realm="r", nonce="n", qop="auth"';
    const digest = await sendAuthorized(
      get('https://a.test/'),
      { type: 'digest', username: 'u', password: 'p' },
      context((init) =>
        header(init, 'authorization')
          ? response(200)
          : response(401, '', [['www-authenticate', challenge]]),
      ),
    );
    const cnonce = /cnonce="([^"]+)"/.exec(String(header(digest.sent, 'authorization')))?.[1];
    expect(cnonce).toMatch(/^[0-9a-f]{32}$/);

    const edge = await authorizeRequest(
      get('https://a.test/'),
      { type: 'edgegrid', accessToken: 'at', clientToken: 'ct', clientSecret: 'cs' },
      context(() => response(200)),
    );
    expect(header(edge, 'authorization')).toMatch(/nonce=[0-9a-f-]{36};/);
  });
});

describe('oauth2 tokens', () => {
  it('reuses a cached token and asks again when it expired', async () => {
    let issued = 0;
    const ctx = context(() => {
      issued += 1;
      return response(200, JSON.stringify({ access_token: `t${issued}`, expires_in: 3600 }));
    });
    const first = await authorizeRequest(get('https://a.test/'), oauth2(), ctx);
    const second = await authorizeRequest(get('https://a.test/'), oauth2(), ctx);
    expect(header(first, 'authorization')).toBe('Bearer t1');
    expect(header(second, 'authorization')).toBe('Bearer t1');
    expect(issued).toBe(1);
  });

  it('keeps a token that never expires', async () => {
    let issued = 0;
    const ctx = context(() => {
      issued += 1;
      return response(200, JSON.stringify({ access_token: `t${issued}` }));
    });
    await authorizeRequest(get('https://a.test/'), oauth2(), ctx);
    await authorizeRequest(get('https://a.test/'), oauth2(), ctx);
    expect(issued).toBe(1);
  });

  it('refreshes with the stored refresh token, and falls back when the refresh fails', async () => {
    const bodies: string[] = [];
    let now = 1_000_000;
    const ctx = context(
      (init) => {
        const body = String(init.body);
        bodies.push(body);
        if (body.includes('grant_type=refresh_token')) return response(400, 'no');
        return response(
          200,
          JSON.stringify({ access_token: 'fresh', refresh_token: 'r1', expires_in: 1 }),
        );
      },
      { now: () => now },
    );
    const first = await authorizeRequest(get('https://a.test/'), oauth2(), ctx);
    expect(header(first, 'authorization')).toBe('Bearer fresh');
    // Past the expiry margin, the cached refresh token is tried before the configured grant.
    now += 3_600_000;
    const second = await authorizeRequest(get('https://a.test/'), oauth2(), ctx);
    expect(header(second, 'authorization')).toBe('Bearer fresh');
    expect(bodies.some((body) => body.includes('grant_type=refresh_token'))).toBe(true);
  });

  it('asks with the refresh_token grant and the configured refresh token', async () => {
    const ctx = context(() => response(200, JSON.stringify({ access_token: 't' })));
    await authorizeRequest(
      get('https://a.test/'),
      oauth2({ grantType: 'refresh_token', refreshToken: 'stored' }),
      ctx,
    );
    expect(String(ctx.calls[0]?.body)).toContain('refresh_token=stored');

    const empty = context(() => response(200, JSON.stringify({ access_token: 't' })));
    await authorizeRequest(get('https://a.test/'), oauth2({ grantType: 'refresh_token' }), empty);
    expect(String(empty.calls[0]?.body)).toContain('refresh_token=');
  });

  it('sends the client id in the body, with and without a secret', async () => {
    const withSecret = context(() => response(200, JSON.stringify({ access_token: 't' })));
    await authorizeRequest(get('https://a.test/'), oauth2(), withSecret);
    expect(String(withSecret.calls[0]?.body)).toContain('client_secret=secret');

    const without = context(() => response(200, JSON.stringify({ access_token: 't' })));
    await authorizeRequest(get('https://a.test/'), oauth2({ clientSecret: '' }), without);
    expect(String(without.calls[0]?.body)).toContain('client_id=id');
    expect(String(without.calls[0]?.body)).not.toContain('client_secret');
  });

  it('reports a token endpoint that refuses the request', async () => {
    const ctx = context(() => response(401, 'denied'));
    await expect(authorizeRequest(get('https://a.test/'), oauth2(), ctx)).rejects.toThrow(
      'OAuth2 token request failed: HTTP 401: denied',
    );
  });

  it('sends the token with no prefix at all', async () => {
    const ctx = context(() => response(200, JSON.stringify({ access_token: 'raw' })));
    const sent = await authorizeRequest(get('https://a.test/'), oauth2({ tokenPrefix: '' }), ctx);
    expect(header(sent, 'authorization')).toBe('raw');
  });

  it('signs a binary body for the grants that hash it', async () => {
    const ctx = context(() => response(200));
    const sent = await authorizeRequest(
      { method: 'POST', url: new URL('https://a.test/'), headers: [], body: Buffer.from('hi') },
      {
        type: 'awsv4',
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
        service: 'execute-api',
        region: 'us-east-1',
      },
      ctx,
    );
    expect(header(sent, 'authorization')).toContain('AWS4-HMAC-SHA256');
  });
});

describe('digest challenges', () => {
  const digest: RequestAuth = { type: 'digest', username: 'u', password: 'p' };

  it('keeps a response that is not a 401', async () => {
    const ctx = context(() => response(200, 'ok'));
    const sent = await sendAuthorized(get('https://a.test/'), digest, ctx);
    expect(ctx.calls.length).toBe(1);
    expect(header(sent.sent, 'authorization')).toBeUndefined();
  });

  it('keeps a 401 that carries no digest challenge it understands', async () => {
    for (const value of [
      'Basic realm="r"',
      'Digest realm="r"',
      'Digest nonce="n", algorithm=RC4',
    ]) {
      const ctx = context(() => response(401, '', [['www-authenticate', value]]));
      const sent = await sendAuthorized(get('https://a.test/'), digest, ctx);
      expect(ctx.calls.length).toBe(1);
      expect(header(sent.sent, 'authorization')).toBeUndefined();
    }
  });

  it('ignores parameters written before any scheme', async () => {
    const ctx = context((init) =>
      header(init, 'authorization')
        ? response(200)
        : response(401, '', [['www-authenticate', 'realm="orphan", Digest realm="r", nonce="n"']]),
    );
    const sent = await sendAuthorized(get('https://a.test/'), digest, ctx);
    expect(header(sent.sent, 'authorization')).toContain('realm="r"');
  });

  it('answers a challenge with no qop, with auth-int and with a session algorithm', async () => {
    const answer = async (challenge: string, body?: string) => {
      const ctx = context((init) =>
        header(init, 'authorization')
          ? response(200)
          : response(401, '', [['www-authenticate', challenge]]),
      );
      const sent = await sendAuthorized(
        {
          method: 'POST',
          url: new URL('https://a.test/x?q=1'),
          headers: [],
          ...(body !== undefined ? { body } : {}),
        },
        digest,
        ctx,
      );
      return String(header(sent.sent, 'authorization'));
    };
    expect(await answer('Digest realm="r", nonce="n"')).not.toContain('qop=');
    expect(await answer('Digest realm="r", nonce="n", qop="auth-int"', '{"a":1}')).toContain(
      'qop=auth-int',
    );
    expect(await answer('Digest realm="r", nonce="n", algorithm=MD5-sess')).toContain(
      'algorithm=MD5-sess',
    );
    expect(await answer('Digest realm="r", nonce="n", qop="replay,auth", opaque="o"')).toContain(
      'opaque="o"',
    );
  });

  it('prefers a SHA-256 challenge over an MD5 one', async () => {
    const ctx = context((init) =>
      header(init, 'authorization')
        ? response(200)
        : response(401, '', [
            ['www-authenticate', 'Digest realm="r", nonce="n", algorithm=MD5'],
            ['www-authenticate', 'Digest realm="r", nonce="n", algorithm=SHA-256'],
          ]),
    );
    const sent = await sendAuthorized(get('https://a.test/'), digest, ctx);
    expect(header(sent.sent, 'authorization')).toContain('algorithm=SHA-256');
  });
});

describe('AWS Signature v4 canonical forms', () => {
  const aws = (service: string): RequestAuth => ({
    type: 'awsv4',
    accessKeyId: 'AK',
    secretAccessKey: 'SK',
    service,
    region: 'us-east-1',
  });

  const sign = async (
    url: string,
    headers: (readonly [string, string])[] = [],
    service = 'execute-api',
  ) =>
    authorizeRequest(
      get(url, headers),
      aws(service),
      context(() => response(200)),
    );

  it('leaves the headers a signature must not cover out of the signed list', async () => {
    const sent = await sign('https://a.test/', [
      ['User-Agent', 'adk'],
      ['Range', 'bytes=0-1'],
      ['X-Custom', '  spaced   value  '],
      ['Host', 'ignored.test'],
    ]);
    const authorization = String(header(sent, 'authorization'));
    expect(authorization).toContain('SignedHeaders=host;x-amz-date;x-custom');
    expect(authorization).not.toContain('user-agent');
  });

  it('normalizes dot, dot-dot and empty path segments outside S3', async () => {
    const sent = await sign('https://a.test/a/./b/../c//d/');
    expect(header(sent, 'authorization')).toContain('AWS4-HMAC-SHA256');
    const root = await sign('https://a.test/../');
    expect(header(root, 'authorization')).toContain('AWS4-HMAC-SHA256');
  });

  it('keeps the path as written for S3 and adds the payload hash', async () => {
    const sent = await sign('https://a.test/a/./b', [], 's3');
    expect(header(sent, 'x-amz-content-sha256')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sorts repeated query keys by their values', async () => {
    const sent = await sign('https://a.test/?b=2&a=zz&a=aa');
    expect(header(sent, 'authorization')).toContain('AWS4-HMAC-SHA256');
  });

  it('keeps a path segment that is not valid percent encoding', async () => {
    const sent = await sign('https://a.test/%E0%A4%A');
    expect(header(sent, 'authorization')).toContain('AWS4-HMAC-SHA256');
  });

  it('adds the session token when the auth carries one', async () => {
    const sent = await authorizeRequest(
      get('https://a.test/'),
      { ...(aws('s3') as Extract<RequestAuth, { type: 'awsv4' }>), sessionToken: 'ST' },
      context(() => response(200)),
    );
    expect(header(sent, 'x-amz-security-token')).toBe('ST');
  });
});

describe('OAuth 1.0a signatures', () => {
  const oauth1 = (extra: Partial<Extract<RequestAuth, { type: 'oauth1' }>> = {}): RequestAuth => ({
    type: 'oauth1',
    consumerKey: 'ck',
    consumerSecret: 'cs',
    signatureMethod: 'HMAC-SHA1',
    ...extra,
  });

  const sign = (url: string, auth: RequestAuth, init: Partial<HttpRequestInit> = {}) =>
    authorizeRequest(
      { method: 'POST', url: new URL(url), headers: [], ...init },
      auth,
      context(() => response(200)),
    );

  it('adds the token, the realm and the signature to the header', async () => {
    const sent = await sign(
      'https://a.test/x',
      oauth1({ token: 't', tokenSecret: 'ts', realm: 'r' }),
    );
    const authorization = String(header(sent, 'authorization'));
    expect(authorization).toContain('realm="r"');
    expect(authorization).toContain('oauth_token="t"');
  });

  it('puts the parameters in the query when asked to', async () => {
    const sent = await sign('https://a.test/x', oauth1({ addTo: 'query' }));
    expect(sent.url.searchParams.get('oauth_signature')).toBeTruthy();
  });

  it('signs with PLAINTEXT and with HMAC-SHA256', async () => {
    const plain = await sign('https://a.test/x', oauth1({ signatureMethod: 'PLAINTEXT' }));
    expect(String(header(plain, 'authorization'))).toContain('oauth_signature="cs%26"');
    const sha256 = await sign('https://a.test/x', oauth1({ signatureMethod: 'HMAC-SHA256' }));
    expect(String(header(sha256, 'authorization'))).toContain('oauth_signature=');
  });

  it('keeps a non-default port in the base string and drops the default ones', async () => {
    for (const url of [
      'http://a.test:80/x',
      'https://a.test:443/x',
      'http://a.test:8080/x',
      'https://a.test/x',
    ]) {
      const sent = await sign(url, oauth1());
      expect(String(header(sent, 'authorization'))).toContain('oauth_signature=');
    }
  });

  it('signs a form-urlencoded body together with the query', async () => {
    const sent = await sign('https://a.test/x?b=2', oauth1(), {
      headers: [['Content-Type', 'application/x-www-form-urlencoded']],
      body: 'a=1&a=0',
    });
    expect(String(header(sent, 'authorization'))).toContain('oauth_signature=');
  });
});

describe('the remaining defaults of each scheme', () => {
  it('sends an empty username and password for a password grant with neither', async () => {
    const ctx = context(() => response(200, JSON.stringify({ access_token: 't' })));
    await authorizeRequest(get('https://a.test/'), oauth2({ grantType: 'password' }), ctx);
    expect(String(ctx.calls[0]?.body)).toContain('username=&password=');
  });

  it('sends the audience when the auth carries one', async () => {
    const ctx = context(() => response(200, JSON.stringify({ access_token: 't' })));
    await authorizeRequest(get('https://a.test/'), oauth2({ audience: 'api://x' }), ctx);
    expect(String(ctx.calls[0]?.body)).toContain('audience=api%3A%2F%2Fx');
  });

  it('refuses a token response with no access token at all', async () => {
    for (const body of ['{"token_type":"Bearer"}', '{"access_token":""}']) {
      const ctx = context(() => response(200, body));
      await expect(authorizeRequest(get('https://a.test/'), oauth2(), ctx)).rejects.toThrow(
        'OAuth2 token response has no access_token',
      );
    }
  });

  it('hashes a Buffer body when signing', async () => {
    const ctx = context((init) =>
      header(init, 'authorization')
        ? response(200)
        : response(401, '', [['www-authenticate', 'Digest realm="r", nonce="n", qop="auth-int"']]),
    );
    const sent = await sendAuthorized(
      {
        method: 'POST',
        url: new URL('https://a.test/x'),
        headers: [],
        body: Buffer.from('bytes'),
      },
      { type: 'digest', username: 'u', password: 'p' },
      ctx,
    );
    expect(header(sent.sent, 'authorization')).toContain('qop=auth-int');
  });

  it('walks up a percent-encoded dot-dot segment', async () => {
    const sent = await authorizeRequest(
      get('https://a.test/a/%2e%2e/b'),
      {
        type: 'awsv4',
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
        service: 'execute-api',
        region: 'us-east-1',
      },
      context(() => response(200)),
    );
    expect(header(sent, 'authorization')).toContain('AWS4-HMAC-SHA256');
  });

  it('compares two query parameters that are exactly equal', async () => {
    const sent = await authorizeRequest(
      get('https://a.test/?a=1&a=1'),
      {
        type: 'awsv4',
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
        service: 'execute-api',
        region: 'us-east-1',
      },
      context(() => response(200)),
    );
    expect(header(sent, 'authorization')).toContain('AWS4-HMAC-SHA256');
  });

  it('signs a request whose parameters repeat a name with the same value', async () => {
    const sent = await authorizeRequest(
      { method: 'POST', url: new URL('https://a.test/x?a=1&a=1'), headers: [] },
      { type: 'oauth1', consumerKey: 'ck', consumerSecret: 'cs', signatureMethod: 'HMAC-SHA1' },
      context(() => response(200)),
    );
    expect(String(header(sent, 'authorization'))).toContain('oauth_signature=');
  });
});
