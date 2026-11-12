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

type Headers = (readonly [string, string])[];

function response(status: number, body = '', headers: Headers = []): HttpResponseData {
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

function header(init: HttpRequestInit, name: string): string | undefined {
  return init.headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function context(
  send: (init: HttpRequestInit, index: number) => HttpResponseData,
  extra: Partial<AuthContext> = {},
): AuthContext & { readonly calls: HttpRequestInit[] } {
  const calls: HttpRequestInit[] = [];
  return {
    calls,
    cache: new Map(),
    send: (init) => {
      calls.push(init);
      return Promise.resolve(send(init, calls.length - 1));
    },
    ...extra,
  };
}

function get(url: string, headers: Headers = []): HttpRequestInit {
  return { method: 'GET', url: new URL(url), headers };
}

/** A URL stand-in, for components `new URL` would normalize away. */
function fakeUrl(parts: {
  protocol?: string;
  hostname?: string;
  port?: string;
  pathname: string;
}): URL {
  const protocol = parts.protocol ?? 'https:';
  const hostname = parts.hostname ?? 'Example.com';
  const port = parts.port ?? '';
  return {
    protocol,
    hostname,
    port,
    host: port ? `${hostname}:${port}` : hostname,
    pathname: parts.pathname,
    search: '',
    searchParams: new URLSearchParams(),
    href: `${protocol}//${hostname}${parts.pathname}`,
  } as unknown as URL;
}

const oauth2: Extract<RequestAuth, { type: 'oauth2' }> = {
  type: 'oauth2',
  grantType: 'client_credentials',
  accessTokenUrl: 'https://auth.example.com/token',
  clientId: 'id',
  clientSecret: 'secret',
};

const form = (init: HttpRequestInit): URLSearchParams => new URLSearchParams(String(init.body));

describe('WSSE and byte bodies with default generators', () => {
  it('uses random nonces and the clock when the context has none', async () => {
    const ctx = context(() => response(200));
    const { sent } = await sendAuthorized(
      get('https://api.example.com/'),
      { type: 'wsse', username: 'u', password: 'p' },
      ctx,
    );
    expect(header(sent, 'X-WSSE')).toMatch(/^UsernameToken Username="u", PasswordDigest="/);
  });

  it('hashes a binary body when signing with AWS SigV4', async () => {
    const ctx = context(() => response(200), { now: () => 0 });
    const { sent } = await sendAuthorized(
      { ...get('https://s3.amazonaws.com/b'), method: 'PUT', body: new Uint8Array([1, 2, 3]) },
      {
        type: 'awsv4',
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
        service: 's3',
        region: 'us-east-1',
      },
      ctx,
    );
    expect(header(sent, 'X-Amz-Content-Sha256')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('OAuth2 token handling', () => {
  it('sends the raw token when the prefix is empty and the default query key', async () => {
    const ctx = context((init) =>
      init.method === 'POST' ? response(200, '{"access_token":"tok"}') : response(200),
    );
    const raw = await sendAuthorized(
      get('https://api.example.com/'),
      { ...oauth2, tokenPrefix: '' },
      ctx,
    );
    expect(header(raw.sent, 'Authorization')).toBe('tok');
    const query = await authorizeRequest(
      get('https://api.example.com/'),
      { ...oauth2, tokenPlacement: 'query', tokenQueryKey: '' },
      ctx,
    );
    expect(query.url.searchParams.get('access_token')).toBe('tok');
  });

  it('refreshes an expired token and falls back to the grant when the refresh fails', async () => {
    let now = 0;
    let failRefresh = false;
    const ctx = context(
      (init) => {
        const params = form(init);
        if (params.get('grant_type') === 'refresh_token' && failRefresh) return response(500, 'x');
        const n = ctx.calls.length;
        const refresh = params.get('grant_type') === 'refresh_token' ? '' : ',"refresh_token":"r1"';
        return init.method === 'POST'
          ? response(200, `{"access_token":"t${n}","expires_in":31${refresh}}`)
          : response(200);
      },
      { now: () => now },
    );
    await sendAuthorized(get('https://api.example.com/'), oauth2, ctx);
    now = 5_000;
    // Expired (31s - 30s margin = 1s): refreshed; the response has no refresh_token, so the old one stays.
    await sendAuthorized(get('https://api.example.com/'), oauth2, ctx);
    const refreshCall = ctx.calls.find((call) => form(call).get('grant_type') === 'refresh_token');
    expect(form(refreshCall!).get('refresh_token')).toBe('r1');
    now = 10_000;
    failRefresh = true;
    await sendAuthorized(get('https://api.example.com/'), oauth2, ctx);
    const grants = ctx.calls
      .filter((call) => call.method === 'POST')
      .map((call) => form(call).get('grant_type'));
    expect(grants.slice(-2)).toEqual(['refresh_token', 'client_credentials']);
  });

  it('uses the configured refresh token, scope and audience, and empty password defaults', async () => {
    const ctx = context((init) =>
      init.method === 'POST' ? response(200, 'access_token=x&expires_in=abc') : response(200),
    );
    await authorizeRequest(
      get('https://api.example.com/'),
      {
        ...oauth2,
        grantType: 'refresh_token',
        refreshToken: 'configured',
        scope: 's',
        audience: 'aud',
        credentialsPlacement: 'basic',
      },
      ctx,
    );
    const first = form(ctx.calls[0]!);
    expect(first.get('refresh_token')).toBe('configured');
    expect(first.get('scope')).toBe('s');
    expect(first.get('audience')).toBe('aud');
    expect(header(ctx.calls[0]!, 'Authorization')).toMatch(/^Basic /);

    const noRefresh = context((init) =>
      init.method === 'POST' ? response(200, '{"access_token":"x"}') : response(200),
    );
    await authorizeRequest(
      get('https://api.example.com/'),
      { ...oauth2, grantType: 'refresh_token', clientSecret: '' },
      noRefresh,
    );
    expect(form(noRefresh.calls[0]!).get('refresh_token')).toBe('');
    expect(form(noRefresh.calls[0]!).has('client_secret')).toBe(false);

    const password = context((init) =>
      init.method === 'POST' ? response(200, '{"access_token":"x"}') : response(200),
    );
    await authorizeRequest(
      get('https://api.example.com/'),
      { ...oauth2, grantType: 'password' },
      password,
    );
    expect(form(password.calls[0]!).get('username')).toBe('');
    expect(form(password.calls[0]!).get('password')).toBe('');
  });

  it('rejects token responses without an access_token', async () => {
    for (const body of ['{"access_token":""}', '{"token":"x"}', '"just a string"', 'null']) {
      const ctx = context(() => response(200, body));
      await expect(authorizeRequest(get('https://api.example.com/'), oauth2, ctx)).rejects.toThrow(
        /no access_token/,
      );
    }
  });
});

describe('Digest challenges', () => {
  const digest: RequestAuth = { type: 'digest', username: 'u', password: 'p' };
  const challenge = (value: string): HttpResponseData =>
    response(401, '', [['www-authenticate', value]]);

  async function answer(value: string, init = get('https://api.example.com/x?y=1')) {
    const ctx = context((_, index) => (index === 0 ? challenge(value) : response(200)), {
      nonce: () => 'cnonce',
    });
    const result = await sendAuthorized(init, digest, ctx);
    return { ctx, authorization: header(result.sent, 'Authorization') };
  }

  it('returns a non-401 response untouched', async () => {
    const ctx = context(() => response(200));
    const result = await sendAuthorized(get('https://api.example.com/'), digest, ctx);
    expect(result.response.status).toBe(200);
    expect(ctx.calls).toHaveLength(1);
  });

  it('does not retry when no supported Digest challenge is offered', async () => {
    for (const value of [
      'Digest realm="r", nonce="n", algorithm=UNKNOWN',
      'Digest nonce="n"',
      'realm="orphan", Basic',
    ]) {
      const { ctx, authorization } = await answer(value);
      expect(authorization).toBeUndefined();
      expect(ctx.calls).toHaveLength(1);
    }
  });

  it('answers without qop, with auth-int and with session algorithms', async () => {
    const plain = await answer('Digest realm="r", nonce="n"');
    expect(plain.authorization).not.toContain('qop=');
    expect(plain.authorization).not.toContain('opaque=');

    const unknownQop = await answer('Digest realm="r", nonce="n", qop="foo"');
    expect(unknownQop.authorization).not.toContain('qop=');

    const authInt = await answer(
      'Digest realm="r", nonce="n", qop="auth-int", algorithm=MD5-SESS, opaque="op"',
      { ...get('https://api.example.com/x'), method: 'POST', body: 'payload' },
    );
    expect(authInt.authorization).toContain('qop=auth-int');
    expect(authInt.authorization).toContain('opaque="op"');
    const preferred = await answer('Digest realm="r", nonce="n", qop="auth-int, auth"');
    expect(preferred.authorization).toContain('qop=auth,');
  });

  it('prefers SHA-256 over MD5 challenges', async () => {
    const both = await answer(
      'Digest realm="r", nonce="a", algorithm=MD5, Digest realm="r", nonce="b", algorithm=SHA-256',
    );
    expect(both.authorization).toContain('algorithm=SHA-256');
  });
});

describe('AWS SigV4 canonical paths', () => {
  const aws: RequestAuth = {
    type: 'awsv4',
    accessKeyId: 'AK',
    secretAccessKey: 'SK',
    service: 'execute-api',
    region: 'eu-west-1',
  };
  const sign = async (url: URL, extra: Partial<AuthContext> = {}) => {
    const ctx = context(() => response(200), { now: () => 0, ...extra });
    const { sent } = await sendAuthorized(
      { method: 'GET', url, headers: [['Host', 'ignored']] },
      aws,
      ctx,
    );
    return header(sent, 'Authorization');
  };

  it('normalizes dot segments and trailing slashes', async () => {
    const dotted = await sign(fakeUrl({ hostname: 'example.com', pathname: '/a/./b/../c//d/' }));
    const clean = await sign(new URL('https://example.com/a/c/d/'));
    expect(dotted).toBe(clean);
    expect(await sign(new URL('https://example.com/'))).toMatch(/^AWS4-HMAC-SHA256/);
  });

  it('keeps undecodable segments and sorts repeated query keys by value', async () => {
    expect(await sign(new URL('https://example.com/%E0%A4%A/x'))).toMatch(/Signature=/);
    const first = await sign(new URL('https://example.com/?a=2&a=1&b=0'));
    const second = await sign(new URL('https://example.com/?b=0&a=1&a=2'));
    expect(first).toBe(second);
    expect(await sign(new URL('https://example.com/?a=1&a=1'))).toMatch(/Signature=/);
  });

  it('applies the security token for non-S3 services', async () => {
    const ctx = context(() => response(200), { now: () => 0 });
    const { sent } = await sendAuthorized(
      get('https://example.com/'),
      { ...aws, sessionToken: 'st' },
      ctx,
    );
    expect(header(sent, 'X-Amz-Security-Token')).toBe('st');
  });
});

describe('OAuth1 base strings', () => {
  const oauth1: RequestAuth = {
    type: 'oauth1',
    consumerKey: 'ck',
    consumerSecret: 'cs',
    signatureMethod: 'HMAC-SHA1',
  };
  const ctxOf = () => context(() => response(200), { now: () => 1000, nonce: () => 'n' });
  const sign = async (init: HttpRequestInit, auth: RequestAuth = oauth1) =>
    header((await sendAuthorized(init, auth, ctxOf())).sent, 'Authorization');

  it('omits default ports and keeps custom ones in the signature base', async () => {
    const withDefaultHttp = await sign({
      method: 'GET',
      url: fakeUrl({ protocol: 'http:', port: '80', pathname: '/p' }),
      headers: [],
    });
    const withoutPort = await sign({
      method: 'GET',
      url: fakeUrl({ protocol: 'http:', pathname: '/p' }),
      headers: [],
    });
    expect(withDefaultHttp).toBe(withoutPort);
    const https443 = await sign({
      method: 'GET',
      url: fakeUrl({ port: '443', pathname: '/p' }),
      headers: [],
    });
    const https = await sign({ method: 'GET', url: fakeUrl({ pathname: '/p' }), headers: [] });
    expect(https443).toBe(https);
    const custom = await sign(get('https://example.com:8443/p'));
    const customNoPort = await sign(get('https://example.com/p'));
    expect(custom).not.toBe(customNoPort);
    const http80OnHttps = await sign({
      method: 'GET',
      url: fakeUrl({ protocol: 'https:', port: '80', pathname: '/p' }),
      headers: [],
    });
    expect(http80OnHttps).not.toBe(https);
  });

  it('works without a token secret, sorts equal names and reads form bodies', async () => {
    const authorization = await sign(
      {
        method: 'POST',
        url: new URL('https://example.com/p?a=2&a=1'),
        headers: [['Content-Type', 'application/x-www-form-urlencoded']],
        body: 'a=0&b=1',
      },
      { ...oauth1, token: 't', signatureMethod: 'HMAC-SHA256' },
    );
    expect(authorization).toContain('oauth_token="t"');
    const bytes = await sign(
      {
        method: 'POST',
        url: new URL('https://example.com/p'),
        headers: [['content-type', 'application/x-www-form-urlencoded']],
        body: new TextEncoder().encode('z=1'),
      },
      oauth1,
    );
    expect(bytes).toContain('oauth_signature=');
    const json = await sign({
      method: 'POST',
      url: new URL('https://example.com/p'),
      headers: [['Content-Type', 'application/json']],
      body: '{}',
    });
    expect(json).toContain('oauth_signature=');
  });
});

describe('EdgeGrid defaults', () => {
  it('generates a UUID nonce when the context has none', async () => {
    const ctx = context(() => response(200), { now: () => 0 });
    const { sent } = await sendAuthorized(
      get('https://example.com/'),
      { type: 'edgegrid', clientToken: 'ct', clientSecret: 'cs', accessToken: 'at' },
      ctx,
    );
    expect(header(sent, 'Authorization')).toMatch(/nonce=[0-9a-f-]{36};/);
  });
});
