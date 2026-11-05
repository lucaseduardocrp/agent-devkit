import { Buffer } from 'node:buffer';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectTarget,
  fetchSender,
  isProxyBypassed,
  matchClientCertificate,
  openSocket,
  parseHttpHead,
  portOf,
  readHandshake,
  sendHttp,
  type CookieHooks,
  type NetworkOptions,
} from '../src/modules/apitests/engine/http-transport.js';
import type { ClientCertificate } from '../src/modules/apitests/engine/types.js';

// Self-signed localhost / 127.0.0.1 test certificate (valid until 2126), test only.
const TEST_CERT = [
  '-----BEGIN CERTIFICATE-----',
  'MIIDJzCCAg+gAwIBAgIUf5x7cInjBKpMcamNKInn0H92V6MwDQYJKoZIhvcNAQEL',
  'BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyOTExMDkxMFoYDzIxMjYx',
  'MDA1MTEwOTEwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB',
  'AQUAA4IBDwAwggEKAoIBAQDLqYA5czZCjU3/b75pSx788wBlYlx+kVWcO5D3T/S+',
  'BwuBWpHHSa3db/OQZy0JDEG5pHMwELUdJHTpkUkXVkIy2H2dD2rKy7/QoS7Ft8bq',
  'CG0Bzkpj/zA1pVifCOyaAoYdOkHXEn+F25w92pjG10izLLlbAdRo3YDxJhlpBuyO',
  'LuUvrQf4XvAdj+wlvHHivsPAEWLK4IDukAbeCfPluLPBcyg87dbMVTEY+fXmfqZ/',
  'AdGD07LIqRNP4JP9gtzTq75u0Eh5kBfdzIosUdmB/dh3gglmdceiIeiFrATPdiyw',
  'WCPseuMg1D5LQJm8bJ9BlDMt4VhHzjKgC3cgaMN1r2L7AgMBAAGjbzBtMB0GA1Ud',
  'DgQWBBSXzD2cbyQ4MViT662sBkyTMevQgjAfBgNVHSMEGDAWgBSXzD2cbyQ4MViT',
  '662sBkyTMevQgjAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z',
  'dIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEApN/piQmCXgZJA9TYcB6lOawXHtIs',
  'vZz1zfZqH13uyZ+pTbbYaXWNpHGnh6KsrMbgTSuK/T2E23eE8rnX66WsC9sKmGt1',
  'bXNlaw8ozVc07hXQd7I4JC7m5cVWR6BmnBPm5Yp477viMrdoGxL204KH+qxODhNV',
  'JBQ0n5fc89Xn4VfUlBJPR61qg8FaYOb5d1fGLyRG6Mm2vPrxO3HGu6iPkSYLJJpY',
  'cLtuqIYSbLRjXoVHDtTrYUMYjoKHvTFDenH53t3F5OFdq5M9mNU786RvLfTEk46K',
  'u/gip6WRHsLCgIVgIBmw+JSIccMWJYIglyP9bKzGI+IPMGnKPb4mXTfDRQ==',
  '-----END CERTIFICATE-----',
].join('\n');
const TEST_KEY = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDLqYA5czZCjU3/',
  'b75pSx788wBlYlx+kVWcO5D3T/S+BwuBWpHHSa3db/OQZy0JDEG5pHMwELUdJHTp',
  'kUkXVkIy2H2dD2rKy7/QoS7Ft8bqCG0Bzkpj/zA1pVifCOyaAoYdOkHXEn+F25w9',
  '2pjG10izLLlbAdRo3YDxJhlpBuyOLuUvrQf4XvAdj+wlvHHivsPAEWLK4IDukAbe',
  'CfPluLPBcyg87dbMVTEY+fXmfqZ/AdGD07LIqRNP4JP9gtzTq75u0Eh5kBfdzIos',
  'UdmB/dh3gglmdceiIeiFrATPdiywWCPseuMg1D5LQJm8bJ9BlDMt4VhHzjKgC3cg',
  'aMN1r2L7AgMBAAECggEAE42OdfWNvA388w0zZsCDlR1vaExtPOmPIpTFcjkG8keS',
  '3zRm0o9MVfotlCuTs06t8LjNJkw0VzvszY/ZSJhLer42MSINyrKNE+alqu3d9xIg',
  'BRBdLASQCFZ7j6k3rgGYBq5VK+TmwV84POgDyvNYU3tzwD0Iu5iojH5v6hl0FKJY',
  'EizHrLUY0c1GpcUxXMpR+EjLbDGI+MC5DLndYGavoja3gMAu3CXfestY9oiCTZ23',
  '9T2GhrMb60dZwclLY/TMbTyYLF2Y5ASOcC7MZ1Ul6rsfHoqZUpXr/9yQvfamPYg9',
  'O1P8TLNGtQQCNFCCwfWF0LwfNG6g1rIzqaIdyBMawQKBgQDvRjHvHPc7/6tidkev',
  'UdvjYd6mmcbV4Y3E6E/FDkaZt81ONXOJoUy071LTDFk8FGo3mkVd8K5OZtUcP2e4',
  'HV9YRhtpsEQuGvByezu5iY8WwGWXm/ck65ihSZn2VUWYMdw9VsTfgqgQfTbAVIb/',
  'RX6zGurC4oI95mIMSDDob0j1uQKBgQDZ5gdPJ2BRX+HqZUAQxCoMCm8gPZe/yg0W',
  'nELN6lJdYMjFtSQPzJxGGpCv4G7xaM0UqlmccWIBrikLof1QHU8mcT/2BR16s9QE',
  'ns77GmIspQEHH93ZBallmHzLKQEMwZjrfBw75nL/aQZ2mw01xgpxVcXsxJdrJpQA',
  'akrCCSF4UwKBgQDJ1km67ZE0gHge562Sm5fEGEPL/331331Kc7kOfftaIezCo14h',
  '4/mjyxnvw8PmZUYwPydyldtDcYUlferNKaHLAeCP58urpLfdqkx4NyyHwaYxHLR+',
  '5Wnr6/0/CTFar/yblX0fGcURm746wVLbNNEq3nLYEGBTPOrKd38iIvXFqQKBgQDH',
  'PjU0xZanEfurrwWTzyt7cxcF7gwSTRkGsb/MNhU2WUd8sRPWdov29leS2q/XgrLz',
  '0Ii8KlkpnCzf/DF6zjIPvsJznV3FUyXtS6GLriZTGFYGQ7dBuJGa2oJR6p6RIX1I',
  '5mWSyDgjH8/PKBw+LWZjF8ExrNmgGth+QLM3Fc5LDQKBgDSgIRJGMGVuLRQXFkja',
  'KoyeZw+OYvtJeHGZOdITNcfXTkVl+B8AGT6FdVfmdCWx4lDFqiSAYjQbYG9HR1k8',
  'wXnEWi0w0x7ejb/qtYcbcE+rLIEIQeMlsjop6SmnXXBH2a/z+lsiv+RUzb6T5LDw',
  'kgp1xNXeOhSS4Ojm/m2IYJKO',
  '-----END PRIVATE KEY-----',
].join('\n');

const TEST_PFX = [
  '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',
  'BAjnH3K2FVGI8gICCAA=',
].join('');

const listen = async (server: net.Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};
const json = (body: Buffer) => JSON.parse(body.toString('utf8')) as Record<string, unknown>;
/** `localhost` may resolve to ::1 first; every test server listens on 127.0.0.1. */
const toIpv4 = (host: string) => (host === 'localhost' ? '127.0.0.1' : host);
const local: NetworkOptions = { connectHost: toIpv4 };

const COMPRESSIBLE = 'hello compressed world '.repeat(50);

function echo(req: http.IncomingMessage, res: http.ServerResponse, body: string) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
}

function routes(other: () => string) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://local');
      const redirect = /^\/r\/(\d{3})$/.exec(url.pathname);
      if (redirect) {
        res.writeHead(Number(redirect[1]), { location: '/echo' });
        return res.end();
      }
      switch (url.pathname) {
        case '/cross':
          res.writeHead(302, { location: `${other()}/echo` });
          return res.end();
        case '/noloc':
          res.writeHead(302);
          return res.end();
        case '/ftp-redirect':
          res.writeHead(302, { location: 'ftp://127.0.0.1/file' });
          return res.end();
        case '/bad-redirect':
          res.writeHead(302, { location: 'http://[bad' });
          return res.end();
        case '/identity':
          res.writeHead(200, { 'content-encoding': 'identity' });
          return res.end('plain');
        case '/corrupt':
          res.writeHead(200, { 'content-encoding': 'gzip' });
          return res.end('definitely not gzip');
        case '/loop':
          res.writeHead(302, { location: '/loop' });
          return res.end();
        case '/gzip':
          res.writeHead(200, { 'content-encoding': 'gzip' });
          return res.end(zlib.gzipSync(COMPRESSIBLE));
        case '/deflate':
          res.writeHead(200, { 'content-encoding': 'deflate' });
          return res.end(zlib.deflateSync(COMPRESSIBLE));
        case '/deflate-raw':
          res.writeHead(200, { 'content-encoding': 'deflate' });
          return res.end(zlib.deflateRawSync(COMPRESSIBLE));
        case '/br':
          res.writeHead(200, { 'content-encoding': 'br' });
          return res.end(zlib.brotliCompressSync(COMPRESSIBLE));
        case '/big':
          res.writeHead(200, { 'content-type': 'text/plain' });
          return res.end('x'.repeat(1000));
        case '/login':
          res.writeHead(302, {
            location: '/echo',
            'set-cookie': ['sid=abc; Path=/', 'theme=dark'],
          });
          return res.end();
        case '/slow':
          setTimeout(() => res.end('late'), 2000).unref();
          return;
        default:
          return echo(req, res, body);
      }
    });
  };
}

let base = '';
let otherBase = '';
const servers: net.Server[] = [];

beforeAll(async () => {
  const main = http.createServer(routes(() => otherBase));
  const other = http.createServer(routes(() => base));
  servers.push(main, other);
  base = `http://127.0.0.1:${await listen(main)}`;
  otherBase = `http://127.0.0.1:${await listen(other)}`;
});

afterAll(() => {
  for (const server of servers) {
    server.close();
    if (server instanceof http.Server) server.closeAllConnections();
  }
});

const get = (path: string, extra: Partial<Parameters<typeof sendHttp>[0]> = {}) => ({
  method: 'GET',
  url: new URL(path, base),
  headers: [] as [string, string][],
  ...extra,
});

describe('sendHttp', () => {
  it('sends headers in order, repeated names and a body with its length', async () => {
    const response = await sendHttp(
      get('/echo', {
        method: 'POST',
        headers: [
          ['x-one', '1'],
          ['x-rep', 'a'],
          ['x-rep', 'b'],
          ['content-type', 'application/json'],
        ],
        body: '{"ok":true}',
      }),
      local,
    );
    expect(response.status).toBe(200);
    expect(response.statusText).toBe('OK');
    expect(response.httpVersion).toBe('1.1');
    expect(response.remoteAddress).toBe('127.0.0.1');
    const seen = json(response.body) as { headers: Record<string, string>; body: string };
    expect(seen.body).toBe('{"ok":true}');
    expect(seen.headers['x-rep']).toBe('a, b');
    expect(seen.headers['content-length']).toBe('11');
    expect(seen.headers.host).toBe(new URL(base).host);
    expect(response.timings.total).toBeGreaterThan(0);
    expect(response.timings.connect).toBeDefined();
    expect(response.timings.firstByte).toBeDefined();
    // An IP literal needs no DNS lookup.
    expect(response.timings.dns).toBeUndefined();
    expect(response.headers.find(([name]) => name === 'content-type')?.[1]).toBe(
      'application/json',
    );
  });

  it('turns POST into GET on 303 (and 301/302) and keeps it on 307/308', async () => {
    for (const status of [301, 302, 303]) {
      const response = await sendHttp(
        get(`/r/${status}`, {
          method: 'POST',
          body: 'payload',
          headers: [['content-type', 'text/plain']],
        }),
        local,
      );
      const seen = json(response.body) as {
        method: string;
        body: string;
        headers: Record<string, string>;
      };
      expect(seen.method).toBe('GET');
      expect(seen.body).toBe('');
      expect(seen.headers['content-type']).toBeUndefined();
      expect(response.redirects).toEqual([{ status, url: `${base}/r/${status}` }]);
      expect(response.url).toBe(`${base}/echo`);
    }
    for (const status of [307, 308]) {
      const response = await sendHttp(
        get(`/r/${status}`, { method: 'POST', body: 'payload' }),
        local,
      );
      expect(json(response.body)).toMatchObject({ method: 'POST', body: 'payload' });
    }
  });

  it('returns the redirect itself when redirects are off', async () => {
    const response = await sendHttp(get('/r/302', { followRedirects: false }), local);
    expect(response.status).toBe(302);
    expect(response.headers).toContainEqual(['location', '/echo']);
    expect(response.redirects).toEqual([]);
  });

  it('guards every hop and drops credentials on another origin', async () => {
    const guarded: string[] = [];
    const guard = (url: URL) => {
      guarded.push(url.href);
      return Promise.resolve();
    };
    const response = await sendHttp(
      get('/cross', {
        headers: [
          ['authorization', 'Bearer secret'],
          ['cookie', 'a=1'],
          ['x-keep', 'yes'],
        ],
      }),
      { ...local, guard },
    );
    expect(guarded).toEqual([`${base}/cross`, `${otherBase}/echo`]);
    const seen = json(response.body) as { headers: Record<string, string> };
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers['x-keep']).toBe('yes');
    expect(seen.headers.host).toBe(new URL(otherBase).host);

    const same = await sendHttp(
      get('/r/302', { headers: [['authorization', 'Bearer secret']] }),
      local,
    );
    expect((json(same.body) as { headers: Record<string, string> }).headers.authorization).toBe(
      'Bearer secret',
    );
  });

  it('refuses a redirect the guard refuses', async () => {
    const guard = (url: URL) =>
      url.port === new URL(otherBase).port
        ? Promise.reject(new Error('blocked target'))
        : Promise.resolve();
    await expect(sendHttp(get('/cross'), { ...local, guard })).rejects.toThrow('blocked target');
  });

  it('stops after maxRedirects', async () => {
    await expect(sendHttp(get('/loop', { maxRedirects: 2 }), local)).rejects.toThrow(
      'Too many redirects (more than 2)',
    );
  });

  it.each(['/gzip', '/deflate', '/deflate-raw', '/br'])('decodes %s bodies', async (path) => {
    const response = await sendHttp(get(path), local);
    expect(response.body.toString()).toBe(COMPRESSIBLE);
    expect(response.sizeBytes).toBe(COMPRESSIBLE.length);
    expect(response.truncated).toBe(false);
  });

  it('keeps only maxBodyBytes but counts the whole body', async () => {
    const response = await sendHttp(get('/big', { maxBodyBytes: 10 }), local);
    expect(response.body.toString()).toBe('x'.repeat(10));
    expect(response.sizeBytes).toBe(1000);
    expect(response.truncated).toBe(true);
    const gzip = await sendHttp(get('/gzip', { maxBodyBytes: 5 }), local);
    expect(gzip.body.toString()).toBe('hello');
    expect(gzip.sizeBytes).toBe(COMPRESSIBLE.length);
  });

  it('calls the cookie hooks on every hop', async () => {
    const stored: [string, readonly string[]][] = [];
    const asked: string[] = [];
    const cookies: CookieHooks = {
      cookieHeader(url) {
        asked.push(url.pathname);
        return url.pathname === '/echo' ? 'sid=abc' : undefined;
      },
      store(url, headers) {
        stored.push([url.pathname, headers]);
      },
    };
    const response = await sendHttp(
      get('/login', { cookies, headers: [['cookie', 'own=1']] }),
      local,
    );
    expect(asked).toEqual(['/login', '/echo']);
    expect(stored).toEqual([['/login', ['sid=abc; Path=/', 'theme=dark']]]);
    expect((json(response.body) as { headers: Record<string, string> }).headers.cookie).toBe(
      'own=1; sid=abc',
    );
  });

  it('times out and aborts', async () => {
    await expect(sendHttp(get('/slow', { timeoutMs: 100 }), local)).rejects.toThrow(
      'Timed out after 100 ms',
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(sendHttp(get('/slow'), { ...local, signal: controller.signal })).rejects.toThrow(
      'The request was aborted',
    );
  });

  it('connects to the mapped host but keeps the Host header', async () => {
    const port = new URL(base).port;
    const response = await sendHttp(
      { method: 'GET', url: new URL(`http://adk-target.invalid:${port}/echo`), headers: [] },
      { connectHost: (host) => (host === 'adk-target.invalid' ? '127.0.0.1' : host) },
    );
    expect((json(response.body) as { headers: Record<string, string> }).headers.host).toBe(
      `adk-target.invalid:${port}`,
    );
  });

  it('reports connection errors', async () => {
    const closed = net.createServer();
    const port = await listen(closed);
    closed.close();
    await expect(
      sendHttp({ method: 'GET', url: new URL(`http://127.0.0.1:${port}/`), headers: [] }, local),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('TLS', () => {
  let secureBase = '';
  let mutualBase = '';
  beforeAll(async () => {
    const secure = https.createServer({ cert: TEST_CERT, key: TEST_KEY }, (req, res) =>
      echo(req, res, ''),
    );
    const mutual = https.createServer(
      {
        cert: TEST_CERT,
        key: TEST_KEY,
        ca: [TEST_CERT],
        requestCert: true,
        rejectUnauthorized: false,
      },
      (req, res) => {
        const socket = req.socket as TLSSocket;
        res.end(JSON.stringify({ cn: socket.getPeerCertificate().subject?.CN ?? null }));
      },
    );
    servers.push(secure, mutual);
    secureBase = `https://localhost:${await listen(secure)}`;
    mutualBase = `https://localhost:${await listen(mutual)}`;
  });

  const at = (root: string) => ({ method: 'GET', url: new URL('/echo', root), headers: [] });

  it('verifies certificates, trusts the extra CA and can skip verification', async () => {
    await expect(sendHttp(at(secureBase), local)).rejects.toThrow(/self[- ]signed/i);
    const trusted = await sendHttp(at(secureBase), { ...local, tls: { caCertificate: TEST_CERT } });
    expect(trusted.status).toBe(200);
    expect(trusted.timings.tls).toBeDefined();
    const unverified = await sendHttp(at(secureBase), { ...local, tls: { verify: false } });
    expect(unverified.status).toBe(200);
  });

  it('sends the client certificate of the matching domain', async () => {
    const certificate = (domain: string): ClientCertificate => ({
      domain,
      type: 'pem',
      cert: TEST_CERT,
      key: TEST_KEY,
    });
    const network = { ...local, tls: { verify: false } };
    const none = await sendHttp(at(mutualBase), {
      ...network,
      clientCertificates: [certificate('other.com')],
    });
    expect(json(none.body)).toEqual({ cn: null });
    const sent = await sendHttp(at(mutualBase), {
      ...network,
      clientCertificates: [certificate('other.com'), certificate('localhost')],
    });
    expect(json(sent.body)).toEqual({ cn: 'localhost' });
  });

  it('opens TLS sockets with ALPN', async () => {
    const socket = (await openSocket(
      { host: 'localhost', port: Number(new URL(secureBase).port), tls: true, alpn: ['http/1.1'] },
      { ...local, tls: { caCertificate: TEST_CERT } },
    )) as TLSSocket;
    expect(socket.alpnProtocol).toBe('http/1.1');
    socket.destroy();
  });
});

describe('client certificate matching', () => {
  const certs: ClientCertificate[] = [
    { domain: 'api.example.com:8443', type: 'pem', cert: 'port' },
    { domain: '*.example.com', type: 'pem', cert: 'wildcard' },
    { domain: 'https://exact.org', type: 'pfx', pfx: 'exact' },
  ];
  it('matches exact names, wildcards over subdomains and ports', () => {
    expect(matchClientCertificate(certs, 'api.example.com', 8443)?.cert).toBe('port');
    expect(matchClientCertificate(certs, 'api.example.com', 443)?.cert).toBe('wildcard');
    expect(matchClientCertificate(certs, 'a.b.example.com', 443)?.cert).toBe('wildcard');
    expect(matchClientCertificate(certs, 'example.com', 443)).toBeUndefined();
    expect(matchClientCertificate(certs, 'EXACT.org', 443)?.pfx).toBe('exact');
    expect(matchClientCertificate(certs, 'other.org', 443)).toBeUndefined();
  });
});

describe('proxy bypass', () => {
  it('matches exact names, *.domain, .domain and *', () => {
    const list = 'localhost, *.internal.net, .corp.com';
    expect(isProxyBypassed('localhost', list)).toBe(true);
    expect(isProxyBypassed('a.internal.net', list)).toBe(true);
    expect(isProxyBypassed('internal.net', list)).toBe(false);
    expect(isProxyBypassed('corp.com', list)).toBe(true);
    expect(isProxyBypassed('x.corp.com', list)).toBe(true);
    expect(isProxyBypassed('example.com', list)).toBe(false);
    expect(isProxyBypassed('anything', '*')).toBe(true);
    expect(isProxyBypassed('anything', undefined)).toBe(false);
  });
});

/** Reads exact byte counts from a socket (test proxies). */
function reader(socket: net.Socket) {
  let buffer = Buffer.alloc(0);
  let wake: (() => void) | null = null;
  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    wake?.();
  };
  socket.on('data', onData);
  return {
    async read(size: number): Promise<Buffer> {
      while (buffer.length < size) await new Promise<void>((resolve) => (wake = resolve));
      const out = buffer.subarray(0, size);
      buffer = buffer.subarray(size);
      return out;
    },
    async readZeroTerminated(): Promise<string> {
      while (!buffer.includes(0)) await new Promise<void>((resolve) => (wake = resolve));
      const end = buffer.indexOf(0);
      const out = buffer.subarray(0, end).toString();
      buffer = buffer.subarray(end + 1);
      return out;
    },
    release(): Buffer {
      socket.off('data', onData);
      // Paused until piped: nothing the client sends in between is lost.
      socket.pause();
      return buffer;
    },
  };
}

/** Writes a byte at a time, so that the client reads partial replies. */
async function dribble(socket: net.Socket, data: Buffer | string): Promise<void> {
  socket.setNoDelay(true);
  for (const byte of Buffer.from(data)) {
    socket.write(Buffer.from([byte]));
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function pipeTo(
  client: net.Socket,
  host: string,
  port: number,
  rest: Buffer,
  reply: Buffer | string,
) {
  const upstream = net.connect(port, toIpv4(host), () => {
    void dribble(client, reply).then(() => {
      if (rest.length) upstream.write(rest);
      upstream.pipe(client);
      client.pipe(upstream);
    });
  });
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
}

const log: string[] = [];

/** An HTTP proxy (forwarding and CONNECT) on `server`; some CONNECT hosts misbehave on purpose. */
function proxyOn<T extends http.Server>(server: T): T {
  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    log.push(`forward ${req.url} ${req.headers['proxy-authorization'] ?? ''}`.trim());
    const target = new URL(req.url ?? '');
    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: req.headers,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    req.pipe(upstream);
  });
  server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on('error', () => {});
    log.push(`connect ${req.url} ${req.headers['proxy-authorization'] ?? ''}`.trim());
    const [host = '', port = ''] = (req.url ?? '').split(/:(?=\d+$)/);
    const replies: Record<string, () => unknown> = {
      'deny.test': () => client.end('HTTP/1.1 403 Forbidden\r\n\r\n'),
      'auth.test': () => client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'),
      'garbage.test': () => client.end('nonsense\r\n\r\n'),
      'huge.test': () => client.write(`HTTP/1.1 200 OK\r\nX-Pad: ${'a'.repeat(70_000)}`),
      'close.test': () => client.end(),
      'hang.test': () => undefined,
    };
    const reply = replies[host];
    if (reply) reply();
    else pipeTo(client, host, Number(port), head, 'HTTP/1.1 200 Connection Established\r\n\r\n');
  });
  return server;
}

const SOCKS5_ACCOUNTS = new Set(['qa:pw', ':pw', 'solo:']);

/** `refuse`: accepts no authentication method at all. */
function socks5Server(refuse = false) {
  return net.createServer((client) => {
    client.on('error', () => {});
    void (async () => {
      const io = reader(client);
      const [, count = 0] = await io.read(2);
      const methods = [...(await io.read(count))];
      if (refuse) return void client.end(Buffer.from([5, 0xff]));
      if (methods.includes(2)) {
        await dribble(client, Buffer.from([5, 2]));
        const [, userLength = 0] = await io.read(2);
        const user = (await io.read(userLength)).toString();
        const [passwordLength = 0] = await io.read(1);
        const password = (await io.read(passwordLength)).toString();
        const ok = SOCKS5_ACCOUNTS.has(`${user}:${password}`);
        client.write(Buffer.from([1, ok ? 0 : 1]));
        if (!ok) return void client.end();
      } else {
        await dribble(client, Buffer.from([5, 0]));
      }
      const [, , , type] = await io.read(4);
      const host =
        type === 1
          ? [...(await io.read(4))].join('.')
          : type === 4
            ? (await io.read(16)).toString('hex')
            : (await io.read((await io.read(1))[0] ?? 0)).toString();
      const port = (await io.read(2)).readUInt16BE(0);
      log.push(`socks5 ${host}:${port}`);
      // IPv6: host unreachable; odd.test: a code outside RFC 1928.
      if (type === 4) return void client.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));
      if (host === 'odd.test')
        return void client.end(Buffer.from([5, 0x20, 0, 1, 0, 0, 0, 0, 0, 0]));
      // Bound address as a domain name or as an IPv6 address: both are valid replies.
      const bound =
        type === 3
          ? Buffer.from([5, 0, 0, 3, 5, ...Buffer.from('bound'), 0, 1])
          : Buffer.from([5, 0, 0, 4, ...new Array<number>(16).fill(0), 0, 1]);
      pipeTo(client, host, port, io.release(), bound);
    })();
  });
}

function socks4Server() {
  return net.createServer((client) => {
    client.on('error', () => {});
    void (async () => {
      const io = reader(client);
      const head = await io.read(8);
      const user = await io.readZeroTerminated();
      const ip = [...head.subarray(4, 8)];
      const host =
        ip[0] === 0 && ip[1] === 0 && ip[2] === 0 ? await io.readZeroTerminated() : ip.join('.');
      const port = head.readUInt16BE(2);
      log.push(`socks4 ${host}:${port} ${user}`.trim());
      if (user === 'deny') return void client.end(Buffer.from([0, 0x5b, 0, 0, 0, 0, 0, 0]));
      pipeTo(client, host, port, io.release(), Buffer.from([0, 0x5a, 0, 0, 0, 0, 0, 0]));
    })();
  });
}

describe('proxies', () => {
  let httpProxy = 0;
  let httpsProxy = 0;
  let socks5 = 0;
  let refusingSocks5 = 0;
  let socks4 = 0;
  let echoPort = 0;
  let secureBase = '';

  beforeAll(async () => {
    const plain = proxyOn(http.createServer());
    const secureProxy = proxyOn(https.createServer({ cert: TEST_CERT, key: TEST_KEY }));
    const socks5s = socks5Server();
    const refusing = socks5Server(true);
    const socks4s = socks4Server();
    const echoServer = net.createServer((socket) => socket.pipe(socket));
    const secure = https.createServer({ cert: TEST_CERT, key: TEST_KEY }, (req, res) =>
      echo(req, res, ''),
    );
    servers.push(plain, secureProxy, socks5s, socks4s, echoServer, secure);
    httpProxy = await listen(plain);
    httpsProxy = await listen(secureProxy);
    socks5 = await listen(socks5s);
    refusingSocks5 = await listen(refusing);
    servers.push(refusing);
    socks4 = await listen(socks4s);
    echoPort = await listen(echoServer);
    secureBase = `https://localhost:${await listen(secure)}`;
  });

  const via = (
    protocol: 'http' | 'https' | 'socks4' | 'socks5',
    port: number,
    extra: object = {},
  ): NetworkOptions => ({
    ...local,
    tls: { caCertificate: TEST_CERT },
    proxy: { enabled: true, protocol, hostname: '127.0.0.1', port, ...extra },
  });
  const basic = (credentials: string) => `Basic ${Buffer.from(credentials).toString('base64')}`;
  const secureGet = () => ({ method: 'GET', url: new URL('/echo', secureBase), headers: [] });

  it('forwards plain HTTP in absolute-form with Proxy-Authorization', async () => {
    log.length = 0;
    const response = await sendHttp(
      get('/echo?x=1'),
      via('http', httpProxy, { username: 'qa', password: 'pw' }),
    );
    expect(response.status).toBe(200);
    await sendHttp(get('/echo'), via('http', httpProxy, { username: 'solo' }));
    await sendHttp(get('/echo'), via('http', httpProxy, { password: 'pw' }));
    expect(log).toEqual([
      `forward ${base}/echo?x=1 ${basic('qa:pw')}`,
      `forward ${base}/echo ${basic('solo:')}`,
      `forward ${base}/echo ${basic(':pw')}`,
    ]);
    // The guard sees the proxy too, and can refuse it.
    const guarded: string[] = [];
    await sendHttp(get('/echo'), {
      ...via('http', httpProxy),
      guard: (url) => {
        guarded.push(url.href);
        return Promise.resolve();
      },
    });
    expect(guarded).toEqual([`${base}/echo`, `http://127.0.0.1:${httpProxy}/`]);
    const refuseProxy = (url: URL) =>
      url.protocol === 'http:' && url.port === String(httpProxy)
        ? Promise.reject(new Error('proxy blocked'))
        : Promise.resolve();
    await expect(
      sendHttp(get('/echo'), { ...via('http', httpProxy), guard: refuseProxy }),
    ).rejects.toThrow('proxy blocked');
  });

  it('tunnels HTTPS and sockets with CONNECT', async () => {
    log.length = 0;
    const response = await sendHttp(
      secureGet(),
      via('http', httpProxy, { username: 'qa', password: 'pw' }),
    );
    expect(response.status).toBe(200);
    expect(log).toEqual([`connect localhost:${new URL(secureBase).port} ${basic('qa:pw')}`]);
    const socket = await openSocket(
      { host: '127.0.0.1', port: echoPort, tls: false },
      via('http', httpProxy),
    );
    expect(await roundTrip(socket, 'ping')).toBe('ping');
  });

  it('speaks TLS to an https proxy', async () => {
    log.length = 0;
    expect((await sendHttp(get('/echo'), via('https', httpsProxy))).status).toBe(200);
    expect((await sendHttp(secureGet(), via('https', httpsProxy))).status).toBe(200);
    expect(log).toEqual([`forward ${base}/echo`, `connect localhost:${new URL(secureBase).port}`]);
  });

  it('reports proxies that refuse or break the tunnel', async () => {
    const through = (host: string, timeoutMs?: number) =>
      sendHttp(
        {
          method: 'GET',
          url: new URL(`https://${host}:443/`),
          headers: [],
          ...(timeoutMs ? { timeoutMs } : {}),
        },
        via('http', httpProxy),
      );
    await expect(through('deny.test')).rejects.toThrow(
      'The proxy refused the tunnel to deny.test:443 (HTTP 403)',
    );
    await expect(through('auth.test')).rejects.toThrow(
      'The proxy requires authentication (HTTP 407)',
    );
    await expect(through('garbage.test')).rejects.toThrow('(HTTP unknown)');
    await expect(through('huge.test')).rejects.toThrow('The handshake reply is too large');
    await expect(through('close.test')).rejects.toThrow(
      'The connection closed during the handshake',
    );
    await expect(through('hang.test', 100)).rejects.toThrow('Timed out after 100 ms');
  });

  it('skips the proxy for bypassed hosts', async () => {
    log.length = 0;
    await sendHttp(get('/echo'), via('http', httpProxy, { bypass: '127.0.0.1' }));
    await sendHttp(get('/echo'), via('http', httpProxy, { enabled: false }));
    await sendHttp(get('/echo'), via('http', httpProxy, { hostname: ' ' }));
    expect(log).toEqual([]);
  });

  it('goes through SOCKS5 with and without a password', async () => {
    log.length = 0;
    const response = await sendHttp(get('/echo'), via('socks5', socks5));
    expect(response.status).toBe(200);
    const port = new URL(base).port;
    const named = (extra: object) =>
      sendHttp(
        { method: 'GET', url: new URL(`http://localhost:${port}/echo`), headers: [] },
        via('socks5', socks5, extra),
      );
    expect((await named({ username: 'qa', password: 'pw' })).status).toBe(200);
    expect((await named({ username: 'solo' })).status).toBe(200);
    expect((await named({ password: 'pw' })).status).toBe(200);
    expect(log).toEqual([
      `socks5 127.0.0.1:${port}`,
      `socks5 localhost:${port}`,
      `socks5 localhost:${port}`,
      `socks5 localhost:${port}`,
    ]);
    await expect(named({ username: 'qa', password: 'wrong' })).rejects.toThrow(
      'rejected the username or password',
    );
    await expect(sendHttp(get('/echo'), via('socks5', refusingSocks5))).rejects.toThrow(
      'accepts none of the offered authentication methods',
    );
  });

  it('reports SOCKS5 connection failures', async () => {
    await expect(
      openSocket({ host: '::1', port: 80, tls: false }, via('socks5', socks5)),
    ).rejects.toThrow('The SOCKS5 proxy could not connect: host unreachable');
    await expect(
      openSocket({ host: '[2001:db8::1:2]', port: 80, tls: false }, via('socks5', socks5)),
    ).rejects.toThrow('host unreachable');
    await expect(
      openSocket({ host: '::ffff:10.0.0.1', port: 80, tls: false }, via('socks5', socks5)),
    ).rejects.toThrow('host unreachable');
    // Fully expanded, with no "::" compression at all.
    await expect(
      openSocket(
        { host: '2001:0db8:0000:0000:0000:0000:0000:0001', port: 80, tls: false },
        via('socks5', socks5),
      ),
    ).rejects.toThrow('host unreachable');
    expect(log.slice(-4)).toEqual([
      `socks5 ${'0'.repeat(31)}1:80`,
      'socks5 20010db8000000000000000000010002:80',
      'socks5 00000000000000000000ffff0a000001:80',
      'socks5 20010db8000000000000000000000001:80',
    ]);
    await expect(
      openSocket({ host: 'odd.test', port: 80, tls: false }, via('socks5', socks5)),
    ).rejects.toThrow('The SOCKS5 proxy could not connect: code 32');
  });

  it('goes through SOCKS4 and SOCKS4a', async () => {
    log.length = 0;
    const socket = await openSocket(
      { host: 'localhost', port: echoPort, tls: false },
      via('socks4', socks4, { username: 'qa' }),
    );
    expect(await roundTrip(socket, 'hi')).toBe('hi');
    const response = await sendHttp(get('/echo'), via('socks4', socks4));
    expect(response.status).toBe(200);
    expect(log).toEqual([
      `socks4 localhost:${echoPort} qa`,
      `socks4 127.0.0.1:${new URL(base).port}`,
    ]);
    await expect(
      openSocket(
        { host: 'localhost', port: echoPort, tls: false },
        via('socks4', socks4, { username: 'deny' }),
      ),
    ).rejects.toThrow('The SOCKS4 proxy refused the connection (code 91)');
    await expect(
      openSocket({ host: '::1', port: echoPort, tls: false }, via('socks4', socks4)),
    ).rejects.toThrow('SOCKS4 proxies do not reach IPv6 addresses');
  });
});

function roundTrip(socket: net.Socket, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('data', (chunk: Buffer) => {
      socket.destroy();
      resolve(chunk.toString());
    });
    socket.once('error', reject);
    socket.write(text);
  });
}

describe('aborts, guards and connection details', () => {
  let echoPort = 0;
  let secureBase = '';
  let mutualBase = '';
  beforeAll(async () => {
    const echoServer = net.createServer((socket) => socket.pipe(socket));
    const secure = https.createServer({ cert: TEST_CERT, key: TEST_KEY }, (req, res) =>
      echo(req, res, ''),
    );
    const mutual = https.createServer(
      {
        cert: TEST_CERT,
        key: TEST_KEY,
        ca: [TEST_CERT],
        requestCert: true,
        rejectUnauthorized: false,
      },
      (req, res) =>
        res.end(String((req.socket as TLSSocket).getPeerCertificate().subject?.CN ?? null)),
    );
    servers.push(echoServer, secure, mutual);
    echoPort = await listen(echoServer);
    secureBase = `https://127.0.0.1:${await listen(secure)}`;
    mutualBase = `https://localhost:${await listen(mutual)}`;
  });

  it('rejects at once when already aborted, with the reason when it is an Error', async () => {
    const aborted = new AbortController();
    aborted.abort('not an error');
    await expect(
      openSocket({ host: '127.0.0.1', port: echoPort, tls: false }, { signal: aborted.signal }),
    ).rejects.toThrow('The request was aborted');
    await expect(sendHttp(get('/echo'), { ...local, signal: aborted.signal })).rejects.toThrow(
      'The request was aborted',
    );
    const custom = new AbortController();
    custom.abort(new Error('custom stop'));
    await expect(sendHttp(get('/echo'), { ...local, signal: custom.signal })).rejects.toThrow(
      'custom stop',
    );
    // Each step gives up at once too.
    await expect(
      connectTarget({ host: '127.0.0.1', port: echoPort, tls: false }, {}, aborted.signal),
    ).rejects.toThrow('The request was aborted');
    const socket = await openSocket({ host: '127.0.0.1', port: echoPort, tls: false }, {});
    await expect(readHandshake(socket, aborted.signal, () => 1)).rejects.toThrow(
      'The request was aborted',
    );
    expect(socket.destroyed).toBe(true);
  });

  it('stops waiting for a slow guard and wraps non-Error refusals', async () => {
    const hang = () => new Promise<void>(() => {});
    await expect(sendHttp(get('/echo', { timeoutMs: 50 }), { guard: hang })).rejects.toThrow(
      'Timed out after 50 ms',
    );
    await expect(sendHttp(get('/echo'), { guard: () => Promise.reject('nope') })).rejects.toThrow(
      'nope',
    );
    const seen: string[] = [];
    await expect(
      openSocket(
        { host: '::1', port: 1, tls: false },
        {
          guard: (url) => {
            seen.push(url.href);
            return Promise.reject(new Error('stop'));
          },
        },
      ),
    ).rejects.toThrow('stop');
    expect(seen).toEqual(['http://[::1]:1/']);
  });

  it('knows default ports', () => {
    expect(portOf(new URL('http://a'))).toBe(80);
    expect(portOf(new URL('ws://a'))).toBe(80);
    expect(portOf(new URL('https://a'))).toBe(443);
    expect(portOf(new URL('wss://a'))).toBe(443);
    expect(portOf(new URL('http://a:8080'))).toBe(8080);
  });

  it('resolves names itself and times the lookup', async () => {
    const response = await sendHttp(
      { method: 'GET', url: new URL(`http://localhost:${new URL(base).port}/echo`), headers: [] },
      {},
    );
    expect(response.status).toBe(200);
    expect(response.timings.dns).toBeDefined();
  });

  it('checks IP certificates without a server name and honors an explicit one', async () => {
    const trusted = { tls: { caCertificate: TEST_CERT } };
    expect(
      (await sendHttp({ method: 'GET', url: new URL('/echo', secureBase), headers: [] }, trusted))
        .status,
    ).toBe(200);
    const socket = (await openSocket(
      {
        host: '127.0.0.1',
        port: Number(new URL(secureBase).port),
        tls: true,
        servername: 'localhost',
      },
      trusted,
    )) as TLSSocket;
    expect((socket as TLSSocket & { servername?: string }).servername).toBe('localhost');
    socket.destroy();
  });

  it('sends PKCS#12 client certificates', async () => {
    const network = { ...local, tls: { verify: false } };
    const at = { method: 'GET', url: new URL('/', mutualBase), headers: [] };
    const sent = await sendHttp(at, {
      ...network,
      clientCertificates: [{ domain: '*', type: 'pfx', pfx: TEST_PFX, passphrase: 'secret' }],
    });
    expect(sent.body.toString()).toBe('localhost');
    await expect(
      sendHttp(at, { ...network, clientCertificates: [{ domain: 'localhost', type: 'pfx' }] }),
    ).rejects.toThrow();
    expect(matchClientCertificate([{ domain: 'a:b:c', type: 'pem' }], 'a')).toBeUndefined();
  });

  it('turns URL credentials into Basic auth unless a header is given', async () => {
    const port = new URL(base).port;
    const url = new URL(`http://us%40er:p%3Aw@127.0.0.1:${port}/echo`);
    const fromUrl = await sendHttp({ method: 'GET', url, headers: [] }, local);
    expect((json(fromUrl.body) as { headers: Record<string, string> }).headers.authorization).toBe(
      `Basic ${Buffer.from('us@er:p:w').toString('base64')}`,
    );
    const own = await sendHttp(
      { method: 'GET', url, headers: [['Authorization', 'Bearer t']] },
      local,
    );
    expect((json(own.body) as { headers: Record<string, string> }).headers.authorization).toBe(
      'Bearer t',
    );
  });

  it('sends no length without a body unless the method expects one', async () => {
    const remove = await sendHttp(get('/echo', { method: 'DELETE' }), local);
    expect(
      (json(remove.body) as { headers: Record<string, string> }).headers['content-length'],
    ).toBeUndefined();
    const post = await sendHttp(
      get('/echo', { method: 'post', headers: [['Content-Length', '99']] }),
      local,
    );
    expect(json(post.body)).toMatchObject({ method: 'POST', headers: { 'content-length': '0' } });
  });

  it('returns redirects it cannot follow and refuses other protocols', async () => {
    for (const path of ['/noloc', '/ftp-redirect', '/bad-redirect']) {
      const response = await sendHttp(get(path), local);
      expect(response.status).toBe(302);
      expect(response.redirects).toEqual([]);
    }
    await expect(sendHttp(get('ftp://127.0.0.1/file'), local)).rejects.toThrow(
      'Unsupported protocol ftp:',
    );
  });

  it('passes unknown encodings through and reports corrupt bodies', async () => {
    expect((await sendHttp(get('/identity'), local)).body.toString()).toBe('plain');
    await expect(sendHttp(get('/corrupt'), local)).rejects.toThrow(
      'Could not decode the gzip response body',
    );
  });

  it('parses odd response heads', () => {
    expect(parseHttpHead(Buffer.from('HTTP/1.1 400\r\nX-A: 1\r\nbroken\r\n\r\n'))).toEqual({
      status: 400,
      statusText: '',
      headers: [['x-a', '1']],
    });
    expect(parseHttpHead(Buffer.from('nonsense\r\n\r\n'))).toMatchObject({
      status: 0,
      statusText: '',
    });
  });
});

describe('fetchSender', () => {
  it('sends through fetch with the redirect mode, guard and cookie hooks', async () => {
    const guarded: string[] = [];
    const stored: string[] = [];
    const network: NetworkOptions = {
      guard: (url) => {
        guarded.push(url.pathname);
        return Promise.resolve();
      },
    };
    const sender = fetchSender(fetch);
    const followed = await sender(
      get('/r/303', {
        method: 'POST',
        body: 'x',
        cookies: { cookieHeader: () => 'sid=1', store: (_url, headers) => stored.push(...headers) },
      }),
      network,
    );
    expect(followed.status).toBe(200);
    expect(followed.url).toBe(`${base}/echo`);
    expect((json(followed.body) as { headers: Record<string, string> }).headers.cookie).toBe(
      'sid=1',
    );
    expect(followed.timings.total).toBeGreaterThan(0);
    expect(guarded).toEqual(['/r/303']);

    const manual = await sender(
      get('/login', {
        followRedirects: false,
        cookies: {
          cookieHeader: () => undefined,
          store: (_url, headers) => stored.push(...headers),
        },
      }),
      network,
    );
    expect(manual.status).toBe(302);
    expect(stored).toEqual(['sid=abc; Path=/', 'theme=dark']);
    const truncated = await sender(get('/big', { maxBodyBytes: 4 }), network);
    expect(truncated).toMatchObject({ sizeBytes: 1000, truncated: true });
    expect(truncated.body.length).toBe(4);
  });

  it('merges cookies, falls back to the request URL and reports failures', async () => {
    let cookie: string | null = null;
    const fake = ((request: Request) => {
      cookie = request.headers.get('cookie');
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;
    const response = await fetchSender(fake)(
      get('/x', {
        headers: [['Cookie', 'own=1']],
        cookies: { cookieHeader: () => 'jar=2', store: () => {} },
      }),
      {},
    );
    expect(cookie).toBe('own=1; jar=2');
    expect(response).toMatchObject({ status: 204, url: `${base}/x`, sizeBytes: 0 });
    const failing = (() => Promise.reject('boom')) as unknown as typeof fetch;
    await expect(fetchSender(failing)(get('/x'), {})).rejects.toThrow('boom');
    const slow = (() => new Promise(() => {})) as typeof fetch;
    await expect(fetchSender(slow)(get('/x', { timeoutMs: 50 }), {})).rejects.toThrow(
      'Timed out after 50 ms',
    );
  });
});
