import { createHash } from 'node:crypto';
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

function header(init: HttpRequestInit, name: string): string | undefined {
  return init.headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

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

function get(url: string, headers: (readonly [string, string])[] = []): HttpRequestInit {
  return { method: 'GET', url: new URL(url), headers };
}

describe('simple auth types', () => {
  it('sends bearer, UTF-8 basic and API keys', async () => {
    const ctx = context(() => response(200));
    const bearer = await sendAuthorized(
      get('https://a.test/'),
      { type: 'bearer', token: 't' },
      ctx,
    );
    expect(header(bearer.sent, 'authorization')).toBe('Bearer t');

    const basic = await sendAuthorized(
      get('https://a.test/'),
      { type: 'basic', username: 'joão', password: 'sé' },
      ctx,
    );
    expect(header(basic.sent, 'authorization')).toBe(
      `Basic ${Buffer.from('joão:sé', 'utf8').toString('base64')}`,
    );

    const query = await sendAuthorized(
      get('https://a.test/x?a=1'),
      { type: 'apikey', key: 'api_key', value: 'v 1', in: 'query' },
      ctx,
    );
    expect(query.sent.url.searchParams.get('api_key')).toBe('v 1');
    expect(query.sent.url.searchParams.get('a')).toBe('1');

    const inHeader = await authorizeRequest(
      get('https://a.test/', [['x-api-key', 'old']]),
      { type: 'apikey', key: 'X-Api-Key', value: 'new', in: 'header' },
      ctx,
    );
    expect(inHeader.headers).toEqual([['X-Api-Key', 'new']]);
  });

  it('sends the request unchanged for none', async () => {
    const ctx = context(() => response(204));
    const init = get('https://a.test/');
    const result = await sendAuthorized(init, { type: 'none' }, ctx);
    expect(result.sent).toBe(init);
    expect(result.response.status).toBe(204);
  });

  it('builds the WSSE UsernameToken', async () => {
    const ctx = context(() => response(200), {
      now: () => Date.UTC(2024, 0, 2, 3, 4, 5),
      nonce: () => 'abc123',
    });
    const { sent } = await sendAuthorized(
      get('https://a.test/'),
      { type: 'wsse', username: 'bob', password: 'secret' },
      ctx,
    );
    const created = '2024-01-02T03:04:05.000Z';
    const digest = createHash('sha1').update(`abc123${created}secret`).digest('base64');
    expect(header(sent, 'authorization')).toBe('WSSE profile="UsernameToken"');
    expect(header(sent, 'x-wsse')).toBe(
      `UsernameToken Username="bob", PasswordDigest="${digest}", ` +
        `Nonce="${Buffer.from('abc123').toString('base64')}", Created="${created}"`,
    );
  });
});

describe('digest auth (RFC 7616 §3.9.1)', () => {
  const challenge = (algorithm: string): readonly [string, string] => [
    'www-authenticate',
    `Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=${algorithm}, ` +
      'nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", ' +
      'opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"',
  ];
  const auth: RequestAuth = { type: 'digest', username: 'Mufasa', password: 'Circle of Life' };
  const cnonce = () => 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ';

  it.each([
    [['MD5'], 'MD5', '8ca523f5e9506fed4657c9700eebdbec'],
    [
      ['SHA-256', 'MD5'],
      'SHA-256',
      '753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1',
    ],
  ])('answers a %s challenge', async (offered, algorithm, expected) => {
    const ctx = context(
      (init) =>
        header(init, 'authorization')
          ? response(200, 'ok')
          : response(401, '', offered.map(challenge)),
      { nonce: cnonce },
    );
    const result = await sendAuthorized(get('http://www.example.org/dir/index.html'), auth, ctx);
    expect(ctx.calls).toHaveLength(2);
    expect(result.response.status).toBe(200);
    const value = header(result.sent, 'authorization') ?? '';
    expect(value).toContain(`response="${expected}"`);
    expect(value).toContain(`algorithm=${algorithm}`);
    expect(value).toContain(
      'qop=auth, nc=00000001, cnonce="f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ"',
    );
    expect(value).toContain('opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"');
    expect(value).toContain('uri="/dir/index.html"');
  });

  it('does not retry without a digest challenge', async () => {
    const ctx = context(() => response(401, '', [['www-authenticate', 'Basic realm="x"']]));
    const result = await sendAuthorized(get('http://a.test/'), auth, ctx);
    expect(ctx.calls).toHaveLength(1);
    expect(result.response.status).toBe(401);
  });

  it('is skipped by authorizeRequest', async () => {
    const init = get('http://a.test/');
    expect(
      await authorizeRequest(
        init,
        auth,
        context(() => response(200)),
      ),
    ).toBe(init);
  });
});

describe('oauth2', () => {
  const auth: RequestAuth = {
    type: 'oauth2',
    grantType: 'client_credentials',
    accessTokenUrl: 'https://auth.test/token',
    clientId: 'client',
    clientSecret: 'secret',
    scope: 'read',
  };

  function server(revoked: Set<string> = new Set()) {
    let issued = 0;
    let now = 1_000_000;
    const ctx = context(
      (init) => {
        if (init.url.href === 'https://auth.test/token') {
          issued += 1;
          return response(200, JSON.stringify({ access_token: `t${issued}`, expires_in: 3600 }), [
            ['content-type', 'application/json'],
          ]);
        }
        const token = (header(init, 'authorization') ?? '').replace('Bearer ', '');
        return response(revoked.has(token) ? 401 : 200, token);
      },
      { now: () => now },
    );
    return {
      ctx,
      issued: () => issued,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('fetches a token once and reuses it until it expires', async () => {
    const { ctx, issued, advance } = server();
    const first = await sendAuthorized(get('https://api.test/a'), auth, ctx);
    expect(header(first.sent, 'authorization')).toBe('Bearer t1');
    const tokenRequest = ctx.calls[0];
    expect(tokenRequest?.method).toBe('POST');
    expect(String(tokenRequest?.body)).toBe(
      'grant_type=client_credentials&scope=read&client_id=client&client_secret=secret',
    );

    await sendAuthorized(get('https://api.test/b'), auth, ctx);
    expect(issued()).toBe(1);

    advance(3600_000 - 29_000); // inside the 30 s safety margin
    const third = await sendAuthorized(get('https://api.test/c'), auth, ctx);
    expect(issued()).toBe(2);
    expect(header(third.sent, 'authorization')).toBe('Bearer t2');
  });

  it('refetches the token once when the API answers 401', async () => {
    const { ctx, issued } = server(new Set(['t1']));
    await sendAuthorized(get('https://api.test/login'), auth, ctx).catch(() => undefined);
    // The fresh t1 is rejected but was not cached before: no retry.
    expect(issued()).toBe(1);
    const result = await sendAuthorized(get('https://api.test/a'), auth, ctx);
    expect(issued()).toBe(2);
    expect(result.response.status).toBe(200);
    expect(header(result.sent, 'authorization')).toBe('Bearer t2');
  });

  it('sends client credentials as Basic and the token in the query', async () => {
    const ctx = context((init) =>
      init.url.pathname === '/token'
        ? response(200, 'access_token=xyz&token_type=bearer')
        : response(200),
    );
    const { sent } = await sendAuthorized(
      get('https://api.test/a'),
      {
        ...auth,
        grantType: 'password',
        username: 'u',
        password: 'p',
        credentialsPlacement: 'basic',
        tokenPlacement: 'query',
      },
      ctx,
    );
    const tokenRequest = ctx.calls[0];
    expect(header(tokenRequest!, 'authorization')).toBe(
      `Basic ${Buffer.from('client:secret').toString('base64')}`,
    );
    expect(String(tokenRequest?.body)).toBe('grant_type=password&username=u&password=p&scope=read');
    expect(sent.url.searchParams.get('access_token')).toBe('xyz');
  });

  it('reports token endpoint failures with the status and body', async () => {
    const ctx = context(() => response(400, `{"error":"invalid_client"}${'x'.repeat(400)}`));
    const error = await sendAuthorized(get('https://api.test/a'), auth, ctx).catch(
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('HTTP 400');
    expect((error as Error).message).toContain('invalid_client');
    expect((error as Error).message.length).toBeLessThan(400);
  });
});

describe('aws signature v4', () => {
  it('matches the AWS documented example', async () => {
    const ctx = context(() => response(200), { now: () => Date.UTC(2015, 7, 30, 12, 36, 0) });
    const { sent } = await sendAuthorized(
      get('https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08', [
        ['Content-Type', 'application/x-www-form-urlencoded; charset=utf-8'],
      ]),
      {
        type: 'awsv4',
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
        service: 'iam',
        region: 'us-east-1',
      },
      ctx,
    );
    expect(header(sent, 'x-amz-date')).toBe('20150830T123600Z');
    expect(header(sent, 'authorization')).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-date, ' +
        'Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
  });

  it('adds the content hash for s3 and the session token', async () => {
    const ctx = context(() => response(200));
    const { sent } = await sendAuthorized(
      {
        method: 'PUT',
        url: new URL('https://bucket.s3.amazonaws.com/a b.txt'),
        headers: [],
        body: 'hi',
      },
      {
        type: 'awsv4',
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
        sessionToken: 'session',
        service: 's3',
        region: 'us-east-1',
      },
      ctx,
    );
    expect(header(sent, 'x-amz-content-sha256')).toBe(
      createHash('sha256').update('hi').digest('hex'),
    );
    expect(header(sent, 'x-amz-security-token')).toBe('session');
    expect(header(sent, 'authorization')).toContain(
      'SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token',
    );
  });
});

describe('oauth1', () => {
  const twitter: RequestAuth = {
    type: 'oauth1',
    consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
    consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
    tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    signatureMethod: 'HMAC-SHA1',
  };
  const twitterContext = () =>
    context(() => response(200), {
      now: () => 1318622958_000,
      nonce: () => 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    });
  const update: HttpRequestInit = {
    method: 'POST',
    url: new URL('https://api.twitter.com/1.1/statuses/update.json?include_entities=true'),
    headers: [['Content-Type', 'application/x-www-form-urlencoded']],
    body: 'status=Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21',
  };

  // Twitter 'Creating a signature' guide: these inputs sign to hCtSmYh+iHYCEqBWrE7C7hYmtUk=.
  it('matches the Twitter documented HMAC-SHA1 example', async () => {
    const { sent } = await sendAuthorized(update, twitter, twitterContext());
    expect(header(sent, 'authorization')).toBe(
      'OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", ' +
        'oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", ' +
        'oauth_signature_method="HMAC-SHA1", oauth_timestamp="1318622958", ' +
        'oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", ' +
        'oauth_version="1.0", oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"',
    );
  });

  it('supports PLAINTEXT, realm and query placement', async () => {
    const plain = await sendAuthorized(
      get('https://a.test/'),
      {
        ...twitter,
        signatureMethod: 'PLAINTEXT',
        consumerSecret: 'cs',
        tokenSecret: 'ts',
        realm: 'r',
      },
      twitterContext(),
    );
    expect(header(plain.sent, 'authorization')).toMatch(/^OAuth realm="r", /);
    expect(header(plain.sent, 'authorization')).toContain('oauth_signature="cs%26ts"');

    const query = await sendAuthorized(
      get('https://a.test/?x=1'),
      { ...twitter, signatureMethod: 'HMAC-SHA256', addTo: 'query' },
      twitterContext(),
    );
    expect(query.sent.url.searchParams.get('oauth_signature_method')).toBe('HMAC-SHA256');
    expect(query.sent.url.searchParams.get('oauth_signature')).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(header(query.sent, 'authorization')).toBeUndefined();
  });
});

describe('akamai edgegrid (official vectors)', () => {
  const host = 'https://akaa-baseurl-xxxxxxxxxxx-xxxxxxxxxxxxx.luna.akamaiapis.net';
  const auth = {
    type: 'edgegrid',
    clientToken: 'akab-client-token-xxx-xxxxxxxxxxxxxxxx',
    accessToken: 'akab-access-token-xxx-xxxxxxxxxxxxxxxx',
    clientSecret: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=',
  } as const;
  const ctx = () =>
    context(() => response(200), {
      now: () => Date.UTC(2014, 2, 21, 19, 34, 21),
      nonce: () => 'nonce-xx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    });
  const signatureOf = (init: HttpRequestInit) =>
    (header(init, 'authorization') ?? '').split('signature=')[1];

  it.each([
    ['GET', '/', undefined, 'tL+y4hxyHxgWVD30X3pWnGKHcPzmrIF+LThiAOhMxYU='],
    ['GET', '/testapi/v1/t1?p1=1&p2=2', undefined, 'hKDH1UlnQySSHjvIcZpDMbQHihTQ0XyVAKZaApabdeA='],
    [
      'POST',
      '/testapi/v1/t3',
      'datadatadatadatadatadatadatadata',
      'hXm4iCxtpN22m4cbZb4lVLW5rhX8Ca82vCFqXzSTPe4=',
    ],
    ['POST', '/testapi/v1/t6', '', '1gEDxeQGD5GovIkJJGcBaKnZ+VaPtrc4qBUHixjsPCQ='],
  ])('%s %s', async (method, path, body, expected) => {
    const { sent } = await sendAuthorized(
      { method, url: new URL(`${host}${path}`), headers: [], body },
      auth,
      ctx(),
    );
    expect(header(sent, 'authorization')).toMatch(
      /^EG1-HMAC-SHA256 client_token=akab-client-token-xxx-xxxxxxxxxxxxxxxx;access_token=akab-access-token-xxx-xxxxxxxxxxxxxxxx;timestamp=20140321T19:34:21\+0000;nonce=nonce-xx-xxxx-xxxx-xxxx-xxxxxxxxxxxx;signature=/,
    );
    expect(signatureOf(sent)).toBe(expected);
  });

  it.each([
    [[['X-Test1', 'test-simple-header']], '8F9AybcRw+PLxnvT+H0JRkjROrrUgsxJTnRXMzqvcwY='],
    [
      [['X-Test1', '     first-thing      second-thing']],
      'WtnneL539UadAAOJwnsXvPqT4Kt6z7HMgBEwAFpt3+c=',
    ],
    [
      [
        ['X-Test2', 't2'],
        ['X-Test1', 't1'],
        ['X-Test3', 't3'],
      ],
      'Wus73Nx8jOYM+kkBFF2q8D1EATRIMr0WLWwpLBgkBqY=',
    ],
  ] as const)('signs the listed headers %#', async (headers, expected) => {
    const sent = await authorizeRequest(
      { method: 'GET', url: new URL(`${host}/testapi/v1/t4`), headers },
      { ...auth, headersToSign: 'X-Test1,X-Test2,X-Test3', maxBodySize: 2048 },
      ctx(),
    );
    expect(signatureOf(sent)).toBe(expected);
  });
});
