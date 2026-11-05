import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { HttpRequestInit, HttpResponseData } from './http-transport.js';
import type { RequestAuth } from './types.js';

// Node built-ins only: copied to the CLI with the rest of the engine.

export interface AuthContext {
  /** Sends a request (token endpoints, digest retries) with the run's network settings. */
  readonly send: (init: HttpRequestInit) => Promise<HttpResponseData>;
  /** Per run: OAuth2 tokens by endpoint, client and scope. */
  readonly cache: Map<string, unknown>;
  readonly now?: () => number;
  /** Nonce generator (digest cnonce, OAuth1, WSSE, EdgeGrid); random by default. */
  readonly nonce?: () => string;
}

type Header = readonly [string, string];
type AuthOf<T extends RequestAuth['type']> = Extract<RequestAuth, { type: T }>;

interface Sent {
  readonly response: HttpResponseData;
  readonly sent: HttpRequestInit;
}

/**
 * Sends `init` with the auth applied. `auth` has its variables resolved (never `inherit`).
 * Bearer, Basic, API key, WSSE: headers or query. OAuth2: fetches (or reuses) a token first.
 * Digest: answers the 401 challenge. AWS SigV4, OAuth1, EdgeGrid: sign the final request.
 * Returns the response and the request as finally sent (for the timeline).
 */
export async function sendAuthorized(
  init: HttpRequestInit,
  auth: RequestAuth,
  context: AuthContext,
): Promise<Sent> {
  if (auth.type === 'digest') return sendDigest(init, auth, context);
  if (auth.type === 'oauth2') return sendOAuth2(init, auth, context);
  const sent = applyAuth(init, auth, context);
  return { response: await context.send(sent), sent };
}

/**
 * The auth as headers and query only, for WebSocket, SSE and gRPC (metadata): Digest is not
 * supported there and is skipped; signatures are computed for an empty body.
 */
export async function authorizeRequest(
  init: HttpRequestInit,
  auth: RequestAuth,
  context: AuthContext,
): Promise<HttpRequestInit> {
  if (auth.type === 'digest') return init;
  if (auth.type === 'oauth2') {
    const token = await oauth2Token(auth, context, false);
    return withToken(init, auth, token.accessToken);
  }
  const signed = applyAuth({ ...init, body: undefined }, auth, context);
  return { ...signed, body: init.body };
}

function applyAuth(
  init: HttpRequestInit,
  auth: RequestAuth,
  context: AuthContext,
): HttpRequestInit {
  switch (auth.type) {
    case 'none':
    case 'inherit':
    case 'digest':
    case 'oauth2':
      return init;
    case 'bearer':
      return withHeader(init, 'Authorization', `Bearer ${auth.token}`);
    case 'basic':
      return withHeader(init, 'Authorization', basicValue(auth.username, auth.password));
    case 'apikey':
      return auth.in === 'query'
        ? withQuery(init, [[auth.key, auth.value]])
        : withHeader(init, auth.key, auth.value);
    case 'wsse':
      return signWsse(init, auth, context);
    case 'awsv4':
      return signAwsV4(init, auth, context);
    case 'oauth1':
      return signOAuth1(init, auth, context);
    case 'edgegrid':
      return signEdgeGrid(init, auth, context);
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers

function nowOf(context: AuthContext): number {
  return context.now ? context.now() : Date.now();
}

function nonceOf(context: AuthContext): string {
  return context.nonce ? context.nonce() : randomBytes(16).toString('hex');
}

function withHeader(init: HttpRequestInit, name: string, value: string): HttpRequestInit {
  const lower = name.toLowerCase();
  const headers: Header[] = init.headers.filter(([key]) => key.toLowerCase() !== lower);
  headers.push([name, value]);
  return { ...init, headers };
}

function withQuery(init: HttpRequestInit, params: readonly Header[]): HttpRequestInit {
  const url = new URL(init.url.href);
  for (const [key, value] of params) url.searchParams.set(key, value);
  return { ...init, url };
}

function headerValue(headers: readonly Header[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find(([key]) => key.toLowerCase() === lower)?.[1];
}

function bodyBytes(body: HttpRequestInit['body']): Buffer {
  if (body === undefined) return Buffer.alloc(0);
  return typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
}

function basicValue(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function hash(
  algorithm: string,
  data: string | Buffer,
  encoding: 'hex' | 'base64' = 'hex',
): string {
  return createHash(algorithm).update(data).digest(encoding);
}

function hmac(algorithm: string, key: string | Buffer, data: string): Buffer {
  return createHmac(algorithm, key).update(data, 'utf8').digest();
}

/** RFC 3986 unreserved-only encoding (what OAuth1 and SigV4 require). */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// ---------------------------------------------------------------------------------------------
// WSSE

function signWsse(
  init: HttpRequestInit,
  auth: AuthOf<'wsse'>,
  context: AuthContext,
): HttpRequestInit {
  const nonce = nonceOf(context);
  const created = new Date(nowOf(context)).toISOString();
  const digest = hash('sha1', nonce + created + auth.password, 'base64');
  const encodedNonce = Buffer.from(nonce, 'utf8').toString('base64');
  const token =
    `UsernameToken Username="${auth.username}", PasswordDigest="${digest}", ` +
    `Nonce="${encodedNonce}", Created="${created}"`;
  return withHeader(
    withHeader(init, 'Authorization', 'WSSE profile="UsernameToken"'),
    'X-WSSE',
    token,
  );
}

// ---------------------------------------------------------------------------------------------
// OAuth2

interface OAuth2Token {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Epoch ms after which the token is fetched again. */
  readonly expiresAt?: number;
}

/** Refreshes this much before the server says the token expires. */
const OAUTH2_EXPIRY_MARGIN_MS = 30_000;

async function sendOAuth2(
  init: HttpRequestInit,
  auth: AuthOf<'oauth2'>,
  context: AuthContext,
): Promise<Sent> {
  const key = oauth2CacheKey(auth);
  const cached = context.cache.has(key);
  const token = await oauth2Token(auth, context, false);
  const sent = withToken(init, auth, token.accessToken);
  const response = await context.send(sent);
  // A cached token may have been revoked or expired early: get a new one and retry once.
  if (response.status !== 401 || !cached) return { response, sent };
  const fresh = await oauth2Token(auth, context, true);
  const retried = withToken(init, auth, fresh.accessToken);
  return { response: await context.send(retried), sent: retried };
}

function withToken(
  init: HttpRequestInit,
  auth: AuthOf<'oauth2'>,
  accessToken: string,
): HttpRequestInit {
  if (auth.tokenPlacement === 'query') {
    return withQuery(init, [[auth.tokenQueryKey || 'access_token', accessToken]]);
  }
  const prefix = auth.tokenPrefix ?? 'Bearer';
  return withHeader(init, 'Authorization', prefix ? `${prefix} ${accessToken}` : accessToken);
}

function oauth2CacheKey(auth: AuthOf<'oauth2'>): string {
  return [
    'oauth2',
    auth.accessTokenUrl,
    auth.clientId,
    auth.scope ?? '',
    auth.grantType,
    auth.username ?? '',
  ].join('\n');
}

async function oauth2Token(
  auth: AuthOf<'oauth2'>,
  context: AuthContext,
  force: boolean,
): Promise<OAuth2Token> {
  const key = oauth2CacheKey(auth);
  const cached = context.cache.get(key) as OAuth2Token | undefined;
  const now = nowOf(context);
  if (cached && !force && (cached.expiresAt === undefined || now < cached.expiresAt)) {
    return cached;
  }
  let token: OAuth2Token | undefined;
  if (cached?.refreshToken) {
    // A failed refresh falls back to the configured grant.
    token = await requestToken(auth, context, cached.refreshToken).catch(() => undefined);
  }
  token ??= await requestToken(auth, context);
  context.cache.set(key, token);
  return token;
}

async function requestToken(
  auth: AuthOf<'oauth2'>,
  context: AuthContext,
  refreshToken?: string,
): Promise<OAuth2Token> {
  const params = new URLSearchParams();
  if (refreshToken !== undefined || auth.grantType === 'refresh_token') {
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', refreshToken ?? auth.refreshToken ?? '');
  } else {
    params.set('grant_type', auth.grantType);
    if (auth.grantType === 'password') {
      params.set('username', auth.username ?? '');
      params.set('password', auth.password ?? '');
    }
  }
  if (auth.scope) params.set('scope', auth.scope);
  if (auth.audience) params.set('audience', auth.audience);
  const headers: Header[] = [
    ['Content-Type', 'application/x-www-form-urlencoded'],
    ['Accept', 'application/json'],
  ];
  if (auth.credentialsPlacement === 'basic') {
    headers.push(['Authorization', basicValue(auth.clientId, auth.clientSecret)]);
  } else {
    params.set('client_id', auth.clientId);
    if (auth.clientSecret) params.set('client_secret', auth.clientSecret);
  }
  const response = await context.send({
    method: 'POST',
    url: new URL(auth.accessTokenUrl),
    headers,
    body: params.toString(),
  });
  const text = response.body.toString('utf8');
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`OAuth2 token request failed: HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  const fields = parseTokenResponse(text);
  const accessToken = fields.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error(`OAuth2 token response has no access_token: ${text.slice(0, 300)}`);
  }
  const expiresIn = Number(fields.expires_in);
  return {
    accessToken,
    refreshToken: typeof fields.refresh_token === 'string' ? fields.refresh_token : refreshToken,
    expiresAt:
      fields.expires_in !== undefined && Number.isFinite(expiresIn)
        ? nowOf(context) + expiresIn * 1000 - OAUTH2_EXPIRY_MARGIN_MS
        : undefined,
  };
}

/** Token endpoints answer JSON (RFC 6749) or, like GitHub's, form-urlencoded. */
function parseTokenResponse(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // not JSON
  }
  return Object.fromEntries(new URLSearchParams(text.trim()));
}

// ---------------------------------------------------------------------------------------------
// Digest (RFC 7616)

interface DigestChallenge {
  readonly realm: string;
  readonly nonce: string;
  readonly qop?: string;
  /** As the server wrote it, echoed back. */
  readonly algorithm: string;
  /** Node hash name. */
  readonly hash: string;
  readonly session: boolean;
  readonly opaque?: string;
}

const DIGEST_HASHES: Readonly<Record<string, string>> = {
  MD5: 'md5',
  'MD5-SESS': 'md5',
  'SHA-256': 'sha256',
  'SHA-256-SESS': 'sha256',
  'SHA-512-256': 'sha512-256',
  'SHA-512-256-SESS': 'sha512-256',
};

async function sendDigest(
  init: HttpRequestInit,
  auth: AuthOf<'digest'>,
  context: AuthContext,
): Promise<Sent> {
  const response = await context.send(init);
  if (response.status !== 401) return { response, sent: init };
  const challenge = pickDigestChallenge(
    response.headers.filter(([name]) => name === 'www-authenticate').map(([, value]) => value),
  );
  if (!challenge) return { response, sent: init };
  const sent = withHeader(
    init,
    'Authorization',
    digestAuthorization(init, auth, challenge, context),
  );
  return { response: await context.send(sent), sent };
}

/** The strongest supported Digest challenge among the `WWW-Authenticate` values. */
function pickDigestChallenge(values: readonly string[]): DigestChallenge | undefined {
  const challenges = values
    .flatMap(parseChallenges)
    .filter((challenge) => challenge.scheme === 'digest')
    .flatMap(({ params }): DigestChallenge[] => {
      const { realm, nonce, qop, opaque, algorithm = 'MD5' } = params;
      const hashName = DIGEST_HASHES[algorithm.toUpperCase()];
      if (realm === undefined || nonce === undefined || hashName === undefined) return [];
      const session = algorithm.toUpperCase().endsWith('-SESS');
      return [{ realm, nonce, qop, opaque, algorithm, hash: hashName, session }];
    });
  return challenges.find((challenge) => challenge.hash === 'sha256') ?? challenges[0];
}

interface Challenge {
  readonly scheme: string;
  readonly params: Record<string, string>;
}

/** Splits a `WWW-Authenticate` value into its challenges (`Basic realm="a", Digest ...`). */
function parseChallenges(value: string): Challenge[] {
  const challenges: Challenge[] = [];
  const pattern = /\s*,?\s*([!#$%&'*+.^_`|~\w-]+)(?:\s*=\s*("(?:[^"\\]|\\.)*"|[^,\s]*))?/gy;
  let current: Challenge | undefined;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null && match[0] !== '') {
    const name = String(match[1]);
    const raw = match[2];
    if (raw === undefined) {
      // A token without `=` starts a new challenge; a following token68 is ignored.
      const scheme = name.toLowerCase();
      current = { scheme, params: {} };
      challenges.push(current);
      continue;
    }
    if (!current) continue;
    current.params[name.toLowerCase()] = raw.startsWith('"')
      ? raw.slice(1, -1).replace(/\\(.)/g, '$1')
      : raw;
  }
  return challenges;
}

function digestAuthorization(
  init: HttpRequestInit,
  auth: AuthOf<'digest'>,
  challenge: DigestChallenge,
  context: AuthContext,
): string {
  const h = (data: string | Buffer): string => hash(challenge.hash, data);
  const uri = `${init.url.pathname}${init.url.search}`;
  const offered = (challenge.qop ?? '').split(',').map((qop) => qop.trim().toLowerCase());
  const qop = offered.includes('auth') ? 'auth' : offered.includes('auth-int') ? 'auth-int' : '';
  const nc = '00000001';
  const cnonce = nonceOf(context);
  let ha1 = h(`${auth.username}:${challenge.realm}:${auth.password}`);
  if (challenge.session) ha1 = h(`${ha1}:${challenge.nonce}:${cnonce}`);
  const method = init.method.toUpperCase();
  const ha2 =
    qop === 'auth-int' ? h(`${method}:${uri}:${h(bodyBytes(init.body))}`) : h(`${method}:${uri}`);
  const response = qop
    ? h(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : h(`${ha1}:${challenge.nonce}:${ha2}`);
  const fields = [
    `username="${auth.username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `algorithm=${challenge.algorithm}`,
    `response="${response}"`,
  ];
  if (qop) fields.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (challenge.opaque !== undefined) fields.push(`opaque="${challenge.opaque}"`);
  return `Digest ${fields.join(', ')}`;
}

// ---------------------------------------------------------------------------------------------
// AWS Signature Version 4

/** Headers that proxies and clients change on the way: never signed (as the aws4 library). */
const AWS_UNSIGNED_HEADERS = new Set([
  'authorization',
  'connection',
  'x-amzn-trace-id',
  'user-agent',
  'expect',
  'presigned-expires',
  'range',
  'content-length',
]);

function signAwsV4(
  init: HttpRequestInit,
  auth: AuthOf<'awsv4'>,
  context: AuthContext,
): HttpRequestInit {
  const amzDate = new Date(nowOf(context)).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const isS3 = auth.service === 's3';
  const payloadHash = hash('sha256', bodyBytes(init.body));
  let signed = withHeader(init, 'X-Amz-Date', amzDate);
  if (isS3) signed = withHeader(signed, 'X-Amz-Content-Sha256', payloadHash);
  if (auth.sessionToken) signed = withHeader(signed, 'X-Amz-Security-Token', auth.sessionToken);

  const canonicalHeaders = new Map<string, string[]>([['host', [init.url.host]]]);
  for (const [name, value] of signed.headers) {
    const lower = name.toLowerCase();
    if (AWS_UNSIGNED_HEADERS.has(lower) || lower === 'host') continue;
    const values = canonicalHeaders.get(lower) ?? [];
    values.push(value.trim().replace(/\s+/g, ' '));
    canonicalHeaders.set(lower, values);
  }
  const entries = [...canonicalHeaders].sort(([a], [b]) => compare(a, b));
  const signedHeaders = entries.map(([name]) => name).join(';');
  const canonicalRequest = [
    init.method.toUpperCase(),
    awsCanonicalPath(init.url.pathname, !isS3),
    awsCanonicalQuery(init.url),
    entries.map(([name, values]) => `${name}:${values.join(',')}\n`).join(''),
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${date}/${auth.region}/${auth.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hash('sha256', canonicalRequest)].join(
    '\n',
  );
  let key = hmac('sha256', `AWS4${auth.secretAccessKey}`, date);
  for (const part of [auth.region, auth.service, 'aws4_request']) key = hmac('sha256', key, part);
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  return withHeader(
    signed,
    'Authorization',
    `AWS4-HMAC-SHA256 Credential=${auth.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  );
}

/** Every service but S3 normalizes the path and encodes each segment twice. */
function awsCanonicalPath(pathname: string, doubleEncode: boolean): string {
  let segments = pathname.split('/').map(safeDecode);
  if (doubleEncode) {
    const normalized: string[] = [];
    for (const segment of segments.slice(1)) {
      /* v8 ignore next -- the URL parser resolves every dot-dot segment before we see it */
      if (segment === '..') normalized.pop();
      else if (segment !== '.' && segment !== '') normalized.push(segment);
    }
    const trailing = pathname.length > 1 && pathname.endsWith('/') && normalized.length > 0;
    segments = ['', ...normalized, ...(trailing ? [''] : [])];
  }
  const encoded = segments.map((segment) => {
    const once = encodeRfc3986(segment);
    return doubleEncode ? encodeRfc3986(once) : once;
  });
  const path = encoded.join('/');
  return path.startsWith('/') ? path : `/${path}`;
}

function awsCanonicalQuery(url: URL): string {
  return [...url.searchParams]
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([ak, av], [bk, bv]) => (ak === bk ? compare(av, bv) : compare(ak, bk)))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------------------------
// OAuth 1.0a (RFC 5849)

function signOAuth1(
  init: HttpRequestInit,
  auth: AuthOf<'oauth1'>,
  context: AuthContext,
): HttpRequestInit {
  const oauthParams: [string, string][] = [
    ['oauth_consumer_key', auth.consumerKey],
    ['oauth_nonce', nonceOf(context)],
    ['oauth_signature_method', auth.signatureMethod],
    ['oauth_timestamp', String(Math.floor(nowOf(context) / 1000))],
  ];
  if (auth.token) oauthParams.push(['oauth_token', auth.token]);
  oauthParams.push(['oauth_version', '1.0']);

  const key = `${encodeRfc3986(auth.consumerSecret)}&${encodeRfc3986(auth.tokenSecret ?? '')}`;
  let signature: string;
  if (auth.signatureMethod === 'PLAINTEXT') {
    signature = key;
  } else {
    const baseString = oauth1BaseString(init, oauthParams);
    const algorithm = auth.signatureMethod === 'HMAC-SHA256' ? 'sha256' : 'sha1';
    signature = hmac(algorithm, key, baseString).toString('base64');
  }
  oauthParams.push(['oauth_signature', signature]);

  if (auth.addTo === 'query') return withQuery(init, oauthParams);
  const fields = oauthParams.map(([name, value]) => `${name}="${encodeRfc3986(value)}"`);
  if (auth.realm) fields.unshift(`realm="${auth.realm}"`);
  return withHeader(init, 'Authorization', `OAuth ${fields.join(', ')}`);
}

function oauth1BaseString(init: HttpRequestInit, oauthParams: readonly Header[]): string {
  const url = init.url;
  const port =
    url.port && !(url.protocol === 'http:' && url.port === '80') && url.port !== '443'
      ? `:${url.port}`
      : '';
  const baseUrl = `${url.protocol}//${url.hostname.toLowerCase()}${port}${url.pathname}`;
  const params: Header[] = [...url.searchParams, ...oauthParams];
  const contentType = headerValue(init.headers, 'content-type') ?? '';
  if (init.body !== undefined && contentType.includes('application/x-www-form-urlencoded')) {
    params.push(...new URLSearchParams(bodyBytes(init.body).toString('utf8')));
  }
  const normalized = params
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([an, av], [bn, bv]) => (an === bn ? compare(av, bv) : compare(an, bn)))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  return [init.method.toUpperCase(), encodeRfc3986(baseUrl), encodeRfc3986(normalized)].join('&');
}

// ---------------------------------------------------------------------------------------------
// Akamai EdgeGrid (EG1-HMAC-SHA256)

const EDGEGRID_MAX_BODY_DEFAULT = 131072;

function signEdgeGrid(
  init: HttpRequestInit,
  auth: AuthOf<'edgegrid'>,
  context: AuthContext,
): HttpRequestInit {
  const nonce = context.nonce ? context.nonce() : randomUUID();
  const timestamp = `${new Date(nowOf(context))
    .toISOString()
    .replace(/-/g, '')
    .replace(/\.\d+Z$/, '')}+0000`;
  const header =
    `EG1-HMAC-SHA256 client_token=${auth.clientToken};access_token=${auth.accessToken};` +
    `timestamp=${timestamp};nonce=${nonce};`;
  const url = init.url;
  const dataToSign = [
    init.method.toUpperCase(),
    url.protocol.replace(':', ''),
    url.host,
    url.pathname + url.search,
    edgeGridHeaders(auth.headersToSign, init.headers),
    edgeGridContentHash(init, auth.maxBodySize || EDGEGRID_MAX_BODY_DEFAULT),
    header,
  ].join('\t');
  // The signing key is the base64 text of HMAC(timestamp), used again as a UTF-8 key.
  const signingKey = hmac('sha256', auth.clientSecret, timestamp).toString('base64');
  const signature = hmac('sha256', signingKey, dataToSign).toString('base64');
  return withHeader(init, 'Authorization', `${header}signature=${signature}`);
}

/** `name:value` of the listed headers present on the request, in the listed order. */
function edgeGridHeaders(headersToSign: string | undefined, headers: readonly Header[]): string {
  if (!headersToSign?.trim()) return '';
  return headersToSign
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '')
    .flatMap((name) => {
      const value = headerValue(headers, name);
      return value === undefined ? [] : [`${name}:${value.trim().replace(/\s+/g, ' ')}`];
    })
    .join('\t');
}

/** Akamai hashes only POST bodies, up to `maxBodySize` bytes. */
function edgeGridContentHash(init: HttpRequestInit, maxBodySize: number): string {
  if (init.method.toUpperCase() !== 'POST') return '';
  const body = bodyBytes(init.body);
  if (body.length === 0) return '';
  return hash('sha256', body.subarray(0, maxBodySize), 'base64');
}
