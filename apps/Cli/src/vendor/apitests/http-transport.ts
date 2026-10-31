import { Buffer } from 'node:buffer';
import http from 'node:http';
import net, { isIP, type Socket } from 'node:net';
import tls, { type ConnectionOptions, type TLSSocket } from 'node:tls';
import zlib from 'node:zlib';
import type { ClientCertificate, ProxySettings, RequestTimeline, TlsSettings } from './types.js';

// HTTP(S), TCP and TLS connections of the engine, written on node:net/node:tls so that the proxy,
// TLS settings, client certificates, host mapping and the guard apply to every connection and
// every redirect hop (fetch followed redirects without asking the guard). Node built-ins only.

/** Where and how connections go: proxy, TLS, client certificates, host mapping and the guard. */
export interface NetworkOptions {
  /** Variables already resolved, personal secrets filled in. */
  readonly proxy?: ProxySettings;
  readonly tls?: TlsSettings;
  readonly clientCertificates?: readonly ClientCertificate[];
  /**
   * Maps the hostname to connect to (host access: `localhost` → `host.docker.internal`). The
   * Host header and the TLS server name keep the original name.
   */
  readonly connectHost?: (hostname: string) => string;
  /** Refuses targets; called for the target of every hop (redirects too) and for the proxy. */
  readonly guard?: (url: URL) => Promise<void>;
  readonly signal?: AbortSignal;
}

/** Cookie jar hooks, called on every hop (redirects too). */
export interface CookieHooks {
  cookieHeader(url: URL): string | undefined;
  store(url: URL, setCookieHeaders: readonly string[]): void;
}

export interface HttpRequestInit {
  readonly method: string;
  readonly url: URL;
  /** In order; repeated names allowed. */
  readonly headers: readonly (readonly [string, string])[];
  readonly body?: Uint8Array | string;
  /** On by default. */
  readonly followRedirects?: boolean;
  /** 5 by default. */
  readonly maxRedirects?: number;
  /** Body bytes kept in memory; the rest is only counted. 2 MB by default. */
  readonly maxBodyBytes?: number;
  readonly timeoutMs?: number;
  readonly cookies?: CookieHooks;
}

export interface HttpResponseData {
  readonly status: number;
  readonly statusText: string;
  /** Raw order, repeated names kept (`set-cookie`). Names lower case. */
  readonly headers: readonly (readonly [string, string])[];
  /** Decoded (gzip, deflate, br) body, up to `maxBodyBytes`. */
  readonly body: Buffer;
  /** Decoded size of the whole body. */
  readonly sizeBytes: number;
  readonly truncated: boolean;
  /** Final URL after redirects. */
  readonly url: string;
  readonly httpVersion: string;
  readonly remoteAddress?: string;
  readonly redirects: readonly { readonly status: number; readonly url: string }[];
  readonly timings: NonNullable<RequestTimeline['timings']>;
}

export type HttpSender = (
  init: HttpRequestInit,
  network: NetworkOptions,
) => Promise<HttpResponseData>;

type HeaderList = readonly (readonly [string, string])[];

const DEFAULT_MAX_BODY = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
/** Limit of a proxy or handshake reply head; a real one is a few hundred bytes. */
const MAX_HEAD_BYTES = 64 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Headers that describe the body; dropped when a redirect turns the request into a GET. */
const BODY_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-encoding',
  'transfer-encoding',
]);
const noop = () => {};

// ---------------------------------------------------------------------------------------------
// Abort and timeout

/** The signal of one operation: the caller's signal plus an optional timeout. Engine internal. */
export interface Lifetime {
  readonly signal: AbortSignal;
  /** The timeout fired (as opposed to the caller aborting). */
  timedOut(): boolean;
  dispose(): void;
}

export function lifetime(
  external: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Lifetime {
  const controller = new AbortController();
  let timedOut = false;
  const onExternal = () => {
    // A plain abort() leaves the generic DOMException; an explicit Error reason is kept.
    const reason: unknown = external?.reason;
    controller.abort(
      new Error(
        reason instanceof Error && reason.name !== 'AbortError'
          ? reason.message
          : 'The request was aborted',
      ),
    );
  };
  if (external?.aborted) onExternal();
  else external?.addEventListener('abort', onExternal, { once: true });
  const timer =
    timeoutMs !== undefined && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort(new Error(`Timed out after ${timeoutMs} ms`));
        }, timeoutMs)
      : undefined;
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternal);
    },
  };
}

/** The abort reason as an Error (lifetimes always abort with one). */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('The request was aborted');
}

/**
 * Calls `abort` when the signal aborts, right away when it already did. Returns the unsubscribe.
 * Callers subscribe last, once their own listeners are in place.
 */
function whenAborted(signal: AbortSignal, abort: () => void): () => void {
  if (signal.aborted) {
    abort();
    return noop;
  }
  signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

/** Settles like `promise`, or rejects with the abort reason as soon as `signal` aborts. */
export function untilAborted<T>(promise: Promise<T> | T, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const unsubscribe = whenAborted(signal, () => reject(abortReason(signal)));
    Promise.resolve(promise).then(
      (value) => {
        unsubscribe();
        resolve(value);
      },
      (error: unknown) => {
        unsubscribe();
        reject(toError(error));
      },
    );
  });
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

const round = (ms: number) => Math.round(ms * 10) / 10;

// ---------------------------------------------------------------------------------------------
// Hosts, proxy bypass and client certificates

/** `[::1]` → `::1`: what node:net expects. */
const bare = (host: string) => host.replace(/^\[|\]$/g, '');
/** `::1` → `[::1]`: what URLs, Host headers and CONNECT authorities expect. */
const urlHost = (host: string) => (isIP(bare(host)) === 6 ? `[${bare(host)}]` : bare(host));

export function portOf(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80;
}

/**
 * Whether `host` skips the proxy: entries are exact names, `*.domain` (subdomains), `.domain`
 * (the domain and its subdomains, as curl's NO_PROXY) or `*` (everything).
 */
export function isProxyBypassed(host: string, bypass: string | undefined): boolean {
  const name = bare(host).toLowerCase();
  return (bypass ?? '')
    .split(',')
    .map((entry) => bare(entry.trim().toLowerCase()))
    .filter(Boolean)
    .some((entry) => {
      if (entry === '*') return true;
      if (entry.startsWith('*.')) return name.endsWith(entry.slice(1));
      if (entry.startsWith('.')) return name === entry.slice(1) || name.endsWith(entry);
      return name === entry;
    });
}

function proxyFor(host: string, proxy: ProxySettings | undefined): ProxySettings | null {
  if (!proxy?.enabled || !proxy.hostname.trim()) return null;
  return isProxyBypassed(host, proxy.bypass) ? null : proxy;
}

/**
 * The client certificate for `hostname`: the first whose domain is the host itself or a
 * `*.domain` wildcard over it, with an optional `:port` that must match too.
 */
export function matchClientCertificate(
  certificates: readonly ClientCertificate[],
  hostname: string,
  port?: number,
): ClientCertificate | undefined {
  const host = bare(hostname).toLowerCase();
  return certificates.find((certificate) => domainMatches(certificate.domain, host, port));
}

function domainMatches(pattern: string, host: string, port: number | undefined): boolean {
  // Postman and Bruno exports sometimes keep a scheme or a path around the host.
  const value = pattern
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/\/.*$/, '');
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(value);
  if (!match) return false;
  const name = bare(match[1]!);
  if (match[2] !== undefined && Number(match[2]) !== port) return false;
  if (name === '*') return true;
  if (name.startsWith('*.')) return host.endsWith(name.slice(1));
  return host === name;
}

function tlsOptions(
  host: string,
  port: number,
  network: NetworkOptions,
  extra: { readonly servername?: string; readonly alpn?: readonly string[] } = {},
): ConnectionOptions {
  const name = bare(host);
  const servername = extra.servername ?? (isIP(name) ? undefined : name);
  const certificate = matchClientCertificate(network.clientCertificates ?? [], name, port);
  const ca = network.tls?.caCertificate?.trim();
  return {
    // With `socket` given, `host` is only what the certificate is checked against.
    host: name,
    ...(servername ? { servername } : {}),
    rejectUnauthorized: network.tls?.verify !== false,
    ...(ca ? { ca: [...tls.rootCertificates, ca] } : {}),
    ...(extra.alpn?.length ? { ALPNProtocols: [...extra.alpn] } : {}),
    ...certificateOptions(certificate),
  };
}

function certificateOptions(certificate: ClientCertificate | undefined): ConnectionOptions {
  if (!certificate) return {};
  // node:tls ignores undefined options, so absent fields need no special casing.
  const { cert, key, passphrase } = certificate;
  return certificate.type === 'pfx'
    ? { pfx: Buffer.from(certificate.pfx ?? '', 'base64'), passphrase }
    : { cert, key, passphrase };
}

// ---------------------------------------------------------------------------------------------
// Socket steps

/**
 * Waits for `event` ('connect', 'secureConnect'), failing on 'error' and on abort (which destroys
 * the socket). A failed connect or TLS handshake always emits 'error' before 'close'.
 */
function waitFor(socket: Socket, event: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe = noop;
    const finish = (error?: Error) => {
      socket.off(event, onEvent);
      socket.off('error', onError);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const onEvent = () => finish();
    const onError = (error: Error) => finish(error);
    socket.once(event, onEvent);
    socket.once('error', onError);
    unsubscribe = whenAborted(signal, () => {
      socket.destroy();
      finish(abortReason(signal));
    });
  });
}

/**
 * Reads from the socket (paused mode) until `complete` returns how many bytes form the reply;
 * the rest is pushed back for whoever reads next. Used for proxy and WebSocket handshakes.
 * Engine internal.
 */
export function readHandshake(
  socket: Socket,
  signal: AbortSignal,
  complete: (data: Buffer) => number | undefined,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    let unsubscribe = noop;
    const finish = (error: Error | null, size = 0) => {
      socket.off('readable', onReadable);
      socket.off('error', onError);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
      unsubscribe();
      if (error) return reject(error);
      const rest = data.subarray(size);
      if (rest.length) socket.unshift(rest);
      resolve(data.subarray(0, size));
    };
    const onReadable = () => {
      let chunk: Buffer | null;
      while ((chunk = socket.read() as Buffer | null) !== null) {
        data = Buffer.concat([data, chunk]);
        const size = complete(data);
        if (size !== undefined) return finish(null, size);
        if (data.length > MAX_HEAD_BYTES)
          return finish(new Error('The handshake reply is too large'));
      }
    };
    const onError = (error: Error) => finish(error);
    const onEnd = () => finish(new Error('The connection closed during the handshake'));
    socket.on('readable', onReadable);
    socket.once('error', onError);
    socket.once('end', onEnd);
    socket.once('close', onEnd);
    unsubscribe = whenAborted(signal, () => {
      socket.destroy();
      finish(abortReason(signal));
    });
  });
}

/** Bytes up to and including the blank line that ends an HTTP head. */
export const httpHeadEnd = (data: Buffer): number | undefined => {
  const end = data.indexOf('\r\n\r\n');
  return end < 0 ? undefined : end + 4;
};

interface Wire {
  readonly socket: Socket;
  readonly dnsAt: number | undefined;
}

async function tcpConnect(
  host: string,
  port: number,
  network: NetworkOptions,
  signal: AbortSignal,
): Promise<Wire> {
  // Only the address changes: Host header and TLS server name keep `host`.
  const address = bare(network.connectHost?.(urlHost(host)) ?? host);
  const socket = net.connect({ host: address, port });
  // Errors after a step are reported by whoever reads next ('close' follows every error).
  socket.on('error', noop);
  let dnsAt: number | undefined;
  socket.once('lookup', () => (dnsAt = performance.now()));
  await waitFor(socket, 'connect', signal);
  return { socket, dnsAt };
}

async function tlsConnect(
  socket: Socket,
  options: ConnectionOptions,
  signal: AbortSignal,
): Promise<TLSSocket> {
  const secure = tls.connect({ ...options, socket });
  secure.on('error', noop);
  await waitFor(secure, 'secureConnect', signal);
  return secure;
}

function proxyAuthorization(proxy: ProxySettings): string | undefined {
  if (!proxy.username && !proxy.password) return undefined;
  const credentials = `${proxy.username ?? ''}:${proxy.password ?? ''}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

async function httpTunnel(
  socket: Socket,
  host: string,
  port: number,
  proxy: ProxySettings,
  signal: AbortSignal,
): Promise<void> {
  const authority = `${urlHost(host)}:${port}`;
  const authorization = proxyAuthorization(proxy);
  socket.write(
    [
      `CONNECT ${authority} HTTP/1.1`,
      `Host: ${authority}`,
      ...(authorization ? [`Proxy-Authorization: ${authorization}`] : []),
      '',
      '',
    ].join('\r\n'),
  );
  const head = (await readHandshake(socket, signal, httpHeadEnd)).toString('latin1');
  const status = Number(/^HTTP\/\d(?:\.\d)? (\d{3})/.exec(head)?.[1] ?? 0);
  if (status < 200 || status > 299) {
    throw new Error(
      status === 407
        ? 'The proxy requires authentication (HTTP 407)'
        : `The proxy refused the tunnel to ${authority} (HTTP ${status || 'unknown'})`,
    );
  }
}

async function socks4Handshake(
  socket: Socket,
  host: string,
  port: number,
  proxy: ProxySettings,
  signal: AbortSignal,
): Promise<void> {
  const name = bare(host);
  if (isIP(name) === 6) throw new Error('SOCKS4 proxies do not reach IPv6 addresses');
  const ipv4 = isIP(name) === 4;
  socket.write(
    Buffer.concat([
      Buffer.from([4, 1, port >> 8, port & 255]),
      // SOCKS4a: 0.0.0.1 asks the proxy to resolve the name sent after the user id.
      Buffer.from(ipv4 ? name.split('.').map(Number) : [0, 0, 0, 1]),
      Buffer.from(proxy.username ?? ''),
      Buffer.from([0]),
      ...(ipv4 ? [] : [Buffer.from(name), Buffer.from([0])]),
    ]),
  );
  const reply = await readHandshake(socket, signal, (data) => (data.length >= 8 ? 8 : undefined));
  if (reply[1] !== 0x5a) {
    throw new Error(`The SOCKS4 proxy refused the connection (code ${reply[1] ?? 'unknown'})`);
  }
}

const SOCKS5_ERRORS: Readonly<Record<number, string>> = {
  1: 'general failure',
  2: 'connection not allowed by the ruleset',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused',
  6: 'TTL expired',
  7: 'command not supported',
  8: 'address type not supported',
};

async function socks5Handshake(
  socket: Socket,
  host: string,
  port: number,
  proxy: ProxySettings,
  signal: AbortSignal,
): Promise<void> {
  const twoBytes = (data: Buffer) => (data.length >= 2 ? 2 : undefined);
  const withPassword = Boolean(proxy.username || proxy.password);
  socket.write(Buffer.from(withPassword ? [5, 2, 0, 2] : [5, 1, 0]));
  const method = (await readHandshake(socket, signal, twoBytes))[1];
  if (method === 2) {
    // RFC 1929 username/password.
    const user = Buffer.from(proxy.username ?? '');
    const password = Buffer.from(proxy.password ?? '');
    socket.write(
      Buffer.concat([
        Buffer.from([1, user.length]),
        user,
        Buffer.from([password.length]),
        password,
      ]),
    );
    if ((await readHandshake(socket, signal, twoBytes))[1] !== 0) {
      throw new Error('The SOCKS5 proxy rejected the username or password');
    }
  } else if (method !== 0) {
    throw new Error('The SOCKS5 proxy accepts none of the offered authentication methods');
  }
  const name = bare(host);
  const address =
    isIP(name) === 4
      ? Buffer.from([1, ...name.split('.').map(Number)])
      : isIP(name) === 6
        ? Buffer.concat([Buffer.from([4]), ipv6Bytes(name)])
        : Buffer.concat([Buffer.from([3, Buffer.byteLength(name)]), Buffer.from(name)]);
  socket.write(
    Buffer.concat([Buffer.from([5, 1, 0]), address, Buffer.from([port >> 8, port & 255])]),
  );
  const reply = await readHandshake(socket, signal, (data) => {
    if (data.length < 5) return undefined;
    const type = data[3];
    const length = type === 1 ? 4 : type === 4 ? 16 : 1 + (data[4] ?? 0);
    return data.length >= 4 + length + 2 ? 4 + length + 2 : undefined;
  });
  const code = reply[1] ?? 1;
  if (code !== 0) {
    throw new Error(`The SOCKS5 proxy could not connect: ${SOCKS5_ERRORS[code] ?? `code ${code}`}`);
  }
}

function ipv6Bytes(address: string): Buffer {
  const groupsOf = (part: string) =>
    part
      ? part.split(':').flatMap((group) => {
          if (!group.includes('.')) return [group];
          const [a = 0, b = 0, c = 0, d = 0] = group.split('.').map(Number);
          return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
        })
      : [];
  const halves = address.replace(/%.*$/, '').split('::');
  const head = groupsOf(halves[0] ?? '');
  const tail = halves.length > 1 ? groupsOf(halves[1] ?? '') : [];
  const groups =
    halves.length > 1
      ? [...head, ...new Array<string>(8 - head.length - tail.length).fill('0'), ...tail]
      : head;
  const bytes = Buffer.alloc(16);
  groups
    .slice(0, 8)
    .forEach((group, index) => bytes.writeUInt16BE(parseInt(group, 16) || 0, index * 2));
  return bytes;
}

// ---------------------------------------------------------------------------------------------
// Connections

/** An open connection to a target, maybe through a proxy. Engine internal. */
export interface Connection {
  readonly socket: Socket;
  readonly phases: { readonly dns?: number; readonly connect?: number; readonly tls?: number };
  /** Address of the TCP peer (the proxy when one is used). */
  readonly remoteAddress?: string;
  /** Set when an HTTP proxy forwards the request (absolute-form, no tunnel). */
  readonly forwardProxy: ProxySettings | null;
  destroy(): void;
}

export interface ConnectTarget {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  /** TLS server name; the host by default. */
  readonly servername?: string;
  readonly alpn?: readonly string[];
}

/**
 * Connects to the target, through the proxy when one applies. The target itself is not guarded
 * here (callers guard the URL they are about to use); the proxy is. With `forward`, plain HTTP
 * targets go through HTTP proxies without a tunnel. Engine internal.
 */
export async function connectTarget(
  target: ConnectTarget,
  network: NetworkOptions,
  signal: AbortSignal,
  forward = false,
): Promise<Connection> {
  const started = performance.now();
  const proxy = proxyFor(target.host, network.proxy);
  const sockets: Socket[] = [];
  const destroy = () => sockets.forEach((socket) => socket.destroy());
  try {
    if (proxy) {
      await untilAborted(network.guard?.(proxyUrl(proxy)), signal);
    }
    const wire = proxy
      ? await tcpConnect(proxy.hostname, proxy.port, network, signal)
      : await tcpConnect(target.host, target.port, network, signal);
    sockets.push(wire.socket);
    let socket: Socket = wire.socket;
    if (proxy?.protocol === 'https') {
      socket = await tlsConnect(socket, tlsOptions(proxy.hostname, proxy.port, network), signal);
      sockets.push(socket);
    }
    const forwarding =
      proxy !== null &&
      forward &&
      !target.tls &&
      (proxy.protocol === 'http' || proxy.protocol === 'https');
    if (proxy && !forwarding) {
      const handshake =
        proxy.protocol === 'socks4'
          ? socks4Handshake
          : proxy.protocol === 'socks5'
            ? socks5Handshake
            : httpTunnel;
      await handshake(socket, target.host, target.port, proxy, signal);
    }
    const tunnelAt = performance.now();
    if (target.tls) {
      const options = tlsOptions(target.host, target.port, network, {
        ...(target.servername ? { servername: target.servername } : {}),
        ...(target.alpn ? { alpn: target.alpn } : {}),
      });
      socket = await tlsConnect(socket, options, signal);
      sockets.push(socket);
    }
    const securedAt = performance.now();
    return {
      socket,
      phases: {
        ...(wire.dnsAt !== undefined ? { dns: round(wire.dnsAt - started) } : {}),
        connect: round(tunnelAt - (wire.dnsAt ?? started)),
        ...(target.tls ? { tls: round(securedAt - tunnelAt) } : {}),
      },
      remoteAddress: wire.socket.remoteAddress,
      forwardProxy: forwarding ? proxy : null,
      destroy,
    };
  } catch (error) {
    destroy();
    throw error;
  }
}

function proxyUrl(proxy: ProxySettings): URL {
  return new URL(`${proxy.protocol}://${urlHost(proxy.hostname)}:${proxy.port}`);
}

/**
 * Opens a TCP or TLS connection, through the proxy when one applies (HTTP CONNECT, SOCKS4,
 * SOCKS5). WebSocket, gRPC and socket requests connect with it.
 */
export async function openSocket(
  target: {
    readonly host: string;
    readonly port: number;
    readonly tls: boolean;
    /** TLS server name; the host by default. */
    readonly servername?: string;
    readonly alpn?: readonly string[];
  },
  network: NetworkOptions,
): Promise<Socket | TLSSocket> {
  const signal = network.signal ?? new AbortController().signal;
  const url = new URL(`${target.tls ? 'https' : 'http'}://${urlHost(target.host)}:${target.port}`);
  await untilAborted(network.guard?.(url), signal);
  return (await connectTarget(target, network, signal)).socket;
}

// ---------------------------------------------------------------------------------------------
// HTTP

interface Hop {
  readonly method: string;
  readonly url: URL;
  readonly headers: HeaderList;
  readonly body?: Uint8Array | string;
}

interface HopResponse {
  readonly response: http.IncomingMessage;
  readonly connection: Connection;
  /** Connected (request about to be written). */
  readonly readyAt: number;
  /** Response head received. */
  readonly responseAt: number;
}

const hasHeader = (headers: HeaderList, name: string) =>
  headers.some(([key]) => key.toLowerCase() === name);

/** The headers actually sent on a hop: Host, cookies, length and fetch-like defaults. */
function hopHeaders(
  hop: Hop,
  first: boolean,
  cookies: CookieHooks | undefined,
): [string, string][] {
  const dropped = new Set(['content-length', 'transfer-encoding', ...(first ? [] : ['host'])]);
  const headers: [string, string][] = hop.headers
    .filter(([name]) => !dropped.has(name.toLowerCase()))
    .map(([name, value]) => [name, value]);
  const jar = cookies?.cookieHeader(hop.url);
  if (jar) {
    const own = headers.find(([name]) => name.toLowerCase() === 'cookie');
    if (own) own[1] = `${own[1]}; ${jar}`;
    else headers.push(['cookie', jar]);
  }
  if ((hop.url.username || hop.url.password) && !hasHeader(headers, 'authorization')) {
    const credentials = `${decodeURIComponent(hop.url.username)}:${decodeURIComponent(hop.url.password)}`;
    headers.push(['authorization', `Basic ${Buffer.from(credentials).toString('base64')}`]);
  }
  if (!hasHeader(headers, 'host')) headers.unshift(['host', hop.url.host]);
  if (!hasHeader(headers, 'accept')) headers.push(['accept', '*/*']);
  if (!hasHeader(headers, 'accept-encoding'))
    headers.push(['accept-encoding', 'gzip, deflate, br']);
  if (hop.body !== undefined) {
    headers.push(['content-length', String(Buffer.byteLength(hop.body))]);
  } else if (['POST', 'PUT', 'PATCH'].includes(hop.method)) {
    headers.push(['content-length', '0']);
  }
  return headers;
}

async function requestOnce(
  hop: Hop,
  network: NetworkOptions,
  signal: AbortSignal,
  first: boolean,
  cookies?: CookieHooks,
): Promise<HopResponse> {
  const { url } = hop;
  const connection = await connectTarget(
    { host: url.hostname, port: portOf(url), tls: url.protocol === 'https:', alpn: ['http/1.1'] },
    network,
    signal,
    true,
  );
  const readyAt = performance.now();
  const headers = hopHeaders(hop, first, cookies);
  const proxy = connection.forwardProxy;
  const authorization = proxy ? proxyAuthorization(proxy) : undefined;
  if (authorization) headers.push(['proxy-authorization', authorization]);
  // An HTTP proxy forwarding a plain request gets the absolute URL (RFC 9112 absolute-form).
  const path = `${proxy ? url.origin : ''}${url.pathname}${url.search}`;
  return new Promise<HopResponse>((resolve, reject) => {
    const request = http.request({
      method: hop.method,
      path,
      // An array keeps the order and repeated names, and node adds nothing but Connection.
      headers: headers.flat(),
      createConnection: () => connection.socket,
      maxHeaderSize: 64 * 1024,
    });
    request.once('error', (error) => {
      connection.destroy();
      reject(error);
    });
    request.once('response', (response) =>
      resolve({ response, connection, readyAt, responseAt: performance.now() }),
    );
    request.end(hop.body);
    // Aborting later (body download) destroys the connection; the body reader sees it close.
    const unsubscribe = whenAborted(signal, () => {
      reject(abortReason(signal));
      request.destroy();
      connection.destroy();
    });
    connection.socket.once('close', unsubscribe);
  });
}

function rawHeaderPairs(raw: readonly string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    pairs.push([raw[index]!.toLowerCase(), raw[index + 1]!]);
  }
  return pairs;
}

function setCookieHeaders(response: http.IncomingMessage): string[] {
  return rawHeaderPairs(response.rawHeaders)
    .filter(([name]) => name === 'set-cookie')
    .map(([, value]) => value);
}

/** A response whose body is not read yet, after following the redirects. Engine internal. */
export interface OpenResponse {
  readonly response: http.IncomingMessage;
  readonly connection: Connection;
  readonly url: URL;
  readonly redirects: readonly { readonly status: number; readonly url: string }[];
  readonly readyAt: number;
  readonly responseAt: number;
}

/**
 * Sends the request and follows its redirects (guard and cookie hooks on every hop). The caller
 * reads the final body (see {@link decodeBody}) and destroys the connection. Engine internal.
 */
export async function openHttpResponse(
  init: HttpRequestInit,
  network: NetworkOptions,
  signal: AbortSignal,
): Promise<OpenResponse> {
  const follow = init.followRedirects !== false;
  const maxRedirects = init.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const redirects: { status: number; url: string }[] = [];
  let hop: Hop = {
    method: init.method.toUpperCase(),
    url: init.url,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
  };
  for (;;) {
    if (hop.url.protocol !== 'http:' && hop.url.protocol !== 'https:') {
      throw new Error(`Unsupported protocol ${hop.url.protocol}`);
    }
    await untilAborted(network.guard?.(hop.url), signal);
    const result = await requestOnce(hop, network, signal, redirects.length === 0, init.cookies);
    const { response } = result;
    const cookies = setCookieHeaders(response);
    if (cookies.length) init.cookies?.store(hop.url, cookies);
    // Client responses always have a status code and message.
    const status = response.statusCode!;
    const next = follow && REDIRECT_STATUSES.has(status) ? redirectTarget(response, hop.url) : null;
    if (!next) return { ...result, url: hop.url, redirects };
    result.connection.destroy();
    if (redirects.length >= maxRedirects) {
      throw new Error(`Too many redirects (more than ${maxRedirects})`);
    }
    redirects.push({ status, url: hop.url.href });
    hop = redirectedHop(hop, status, next);
  }
}

function redirectTarget(response: http.IncomingMessage, base: URL): URL | null {
  const location = response.headers.location;
  if (!location) return null;
  try {
    const next = new URL(location, base);
    return next.protocol === 'http:' || next.protocol === 'https:' ? next : null;
  } catch {
    return null;
  }
}

function redirectedHop(hop: Hop, status: number, next: URL): Hop {
  // As browsers and fetch: 303 turns anything but HEAD into GET, 301/302 turn POST into GET.
  const toGet =
    (status === 303 && hop.method !== 'HEAD' && hop.method !== 'GET') ||
    ((status === 301 || status === 302) && hop.method === 'POST');
  // Credentials never follow a redirect to another origin.
  const crossOrigin = next.origin !== hop.url.origin;
  const headers = hop.headers.filter(([name]) => {
    const key = name.toLowerCase();
    if (toGet && BODY_HEADERS.has(key)) return false;
    return !(crossOrigin && (key === 'authorization' || key === 'cookie'));
  });
  return {
    method: toGet ? 'GET' : hop.method,
    url: next,
    headers,
    ...(!toGet && hop.body !== undefined ? { body: hop.body } : {}),
  };
}

function decoderFor(
  encoding: string,
  firstByte: number,
): zlib.Gunzip | zlib.Inflate | zlib.InflateRaw | zlib.BrotliDecompress | undefined {
  // Sync flush: a body cut short still yields what was decoded (as curl and browsers do).
  const lenient = { flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH };
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip(lenient);
    case 'deflate':
      // Some servers send raw deflate without the zlib header (whose low nibble is 8).
      return (firstByte & 0x0f) === 0x08
        ? zlib.createInflate(lenient)
        : zlib.createInflateRaw(lenient);
    case 'br':
      return zlib.createBrotliDecompress({
        flush: zlib.constants.BROTLI_OPERATION_FLUSH,
        finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
      });
    default:
      return undefined;
  }
}

/**
 * Feeds the decoded body (gzip, x-gzip, deflate, br; one encoding) to `onData`; resolves when it
 * ends, rejects when the connection closes first. Engine internal.
 */
export function decodeBody(
  response: http.IncomingMessage,
  onData: (chunk: Buffer) => void,
): Promise<void> {
  const encoding = String(response.headers['content-encoding'] ?? '')
    .trim()
    .toLowerCase();
  return new Promise((resolve, reject) => {
    let decoder: ReturnType<typeof decoderFor>;
    // Settling twice is harmless: the first outcome wins.
    const finish = (error?: Error) => (error ? reject(error) : resolve());
    response.on('data', (chunk: Buffer) => {
      if (!decoder && encoding) {
        decoder = decoderFor(encoding, chunk[0]!);
        decoder?.on('data', onData);
        decoder?.once('end', () => finish());
        decoder?.once('error', (error) =>
          finish(new Error(`Could not decode the ${encoding} response body: ${error.message}`)),
        );
      }
      if (decoder) decoder.write(chunk);
      else onData(chunk);
    });
    response.once('end', () => (decoder ? decoder.end() : finish()));
    // A cut connection emits 'error' ("aborted") then 'close': reported once, on 'close'.
    response.on('error', noop);
    response.once('close', () => {
      if (!response.complete) finish(new Error('The connection closed before the response ended'));
    });
  });
}

/** Keeps the first `limit` bytes, counts all of them. */
function bodyCollector(limit: number) {
  const chunks: Buffer[] = [];
  let kept = 0;
  let size = 0;
  return {
    add(chunk: Buffer) {
      size += chunk.length;
      const part = chunk.subarray(0, Math.max(0, limit - kept));
      chunks.push(part);
      kept += part.length;
    },
    result: () => ({ body: Buffer.concat(chunks), sizeBytes: size, truncated: size > kept }),
  };
}

/** Sends one HTTP(S) request with node:http/node:https: proxy, TLS options, redirects, timings. */
export const sendHttp: HttpSender = (init, network) => {
  const started = performance.now();
  const life = lifetime(network.signal, init.timeoutMs);
  let opened: OpenResponse | undefined;
  const send = async (): Promise<HttpResponseData> => {
    opened = await openHttpResponse(init, network, life.signal);
    const { response, connection } = opened;
    const collector = bodyCollector(init.maxBodyBytes ?? DEFAULT_MAX_BODY);
    await decodeBody(response, (chunk) => collector.add(chunk));
    const ended = performance.now();
    return {
      status: response.statusCode!,
      statusText: response.statusMessage!,
      headers: rawHeaderPairs(response.rawHeaders),
      ...collector.result(),
      url: opened.url.href,
      httpVersion: response.httpVersion,
      remoteAddress: connection.remoteAddress,
      redirects: opened.redirects,
      timings: {
        ...connection.phases,
        firstByte: round(opened.responseAt - opened.readyAt),
        download: round(ended - opened.responseAt),
        total: round(ended - started),
      },
    };
  };
  return within(life, send, () => opened?.connection.destroy());
};

/**
 * Runs `work` in `life`: an abort surfaces as its reason, then `cleanup` runs and the timer ends.
 * (A promise chain rather than try/finally, whose unreachable continuation v8 counts as a branch.)
 */
function within<T>(life: Lifetime, work: () => Promise<T>, cleanup: () => void = noop): Promise<T> {
  return work()
    .catch((error: unknown) => {
      throw life.signal.aborted ? abortReason(life.signal) : toError(error);
    })
    .finally(() => {
      cleanup();
      life.dispose();
    });
}

/** An {@link HttpSender} over a fetch implementation (tests, custom fetches); no proxy or TLS. */
export function fetchSender(fetchImpl: typeof fetch): HttpSender {
  return (init, network) => {
    const started = performance.now();
    const life = lifetime(network.signal, init.timeoutMs);
    const send = async (): Promise<HttpResponseData> => {
      await untilAborted(network.guard?.(init.url), life.signal);
      const headers = new Headers();
      for (const [name, value] of init.headers) headers.append(name, value);
      const jar = init.cookies?.cookieHeader(init.url);
      if (jar)
        headers.set('cookie', headers.has('cookie') ? `${headers.get('cookie')}; ${jar}` : jar);
      const method = init.method.toUpperCase();
      const sendsBody = init.body !== undefined && method !== 'GET' && method !== 'HEAD';
      const redirect: RequestRedirect = init.followRedirects === false ? 'manual' : 'follow';
      const request = new Request(init.url, {
        method,
        headers,
        ...(sendsBody ? { body: init.body as BodyInit } : {}),
        redirect,
        signal: life.signal,
      });
      // A custom fetch may ignore the signal: the lifetime still bounds it.
      const response = await untilAborted(fetchImpl(request, { redirect }), life.signal);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) init.cookies?.store(init.url, cookies);
      const collector = bodyCollector(init.maxBodyBytes ?? DEFAULT_MAX_BODY);
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          collector.add(Buffer.from(value));
        }
      }
      return {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers].map(([name, value]) => [name.toLowerCase(), value] as const),
        ...collector.result(),
        url: response.url || init.url.href,
        httpVersion: '1.1',
        redirects: [],
        timings: { total: round(performance.now() - started) },
      };
    };
    return within(life, send);
  };
}

/** Response head parsing for hand-written handshakes (WebSocket). Engine internal. */
export function parseHttpHead(head: Buffer): {
  readonly status: number;
  readonly statusText: string;
  readonly headers: [string, string][];
} {
  const lines = head.toString('latin1').split('\r\n');
  const statusLine = lines.shift()!;
  const match = /^HTTP\/\d(?:\.\d)? (\d{3})(?: (.*))?$/.exec(statusLine);
  const headers: [string, string][] = [];
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0)
      headers.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
  }
  return { status: Number(match?.[1] ?? 0), statusText: match?.[2] ?? '', headers };
}
