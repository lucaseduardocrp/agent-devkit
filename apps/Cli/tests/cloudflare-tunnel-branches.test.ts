import type * as Https from 'node:https';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import {
  createServer,
  request,
  request as httpRequest,
  type RequestOptions,
  type Server,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Server as NetServer, type AddressInfo } from 'node:net';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudflareTunnelManager, createLocalGateway } from '../src/e2e/cloudflare-tunnel.js';

vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof Https>();
  return { ...actual, request: vi.fn(actual.request) };
});

const TOKEN = { clientId: 'adk-local-test', clientSecret: 'private-key' };
const AUTH = {
  'cf-access-client-id': TOKEN.clientId,
  'cf-access-client-secret': TOKEN.clientSecret,
};
const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    servers
      .splice(0)
      .filter((server) => server.listening)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function rawStatus(base: string, path: string) {
  return new Promise<number>((resolve, reject) => {
    const outgoing = request(`${base}/`, { path, headers: AUTH }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}

const encoded = (origin: string) => Buffer.from(origin).toString('base64url');

function fakeProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  }) as unknown as ChildProcessWithoutNullStreams;
  const factory = vi.fn(() => child) as unknown as typeof spawn;
  return { child, factory };
}

/** Prints the line cloudflared writes when the tunnel is ready, as the process would. */
const announce = (child: ChildProcessWithoutNullStreams, name: string) =>
  child.stderr.emit('data', Buffer.from(`INF https://${name}.trycloudflare.com\n`));

describe('tunnel targets', () => {
  it('asks for a URL it can read', async () => {
    const tunnel = new CloudflareTunnelManager('cloudflared', fakeProcess().factory);
    await expect(tunnel.start('not a url')).rejects.toThrow('Enter a local URL');
  });

  it.each([
    'https://localhost:5173',
    'http://example.com',
    'http://user:pw@localhost:5173',
    'http://localhost:5173/?token=1',
    'http://localhost:5173/#section',
  ])('refuses %s', async (target) => {
    const tunnel = new CloudflareTunnelManager('cloudflared', fakeProcess().factory);
    await expect(tunnel.start(target)).rejects.toThrow('HTTP loopback URL');
  });

  it('runs cloudflared from ADK_CLOUDFLARED_PATH, or from the PATH by default', async () => {
    vi.stubEnv('ADK_CLOUDFLARED_PATH', '');
    const fallback = fakeProcess();
    const byDefault = new CloudflareTunnelManager(undefined, fallback.factory);
    void byDefault.start('http://localhost:5173').catch(() => undefined);
    expect(vi.mocked(fallback.factory).mock.calls[0]![0]).toBe('cloudflared');
    byDefault.stop();

    vi.stubEnv('ADK_CLOUDFLARED_PATH', 'C:/tools/cloudflared.exe');
    const custom = fakeProcess();
    const fromEnv = new CloudflareTunnelManager(undefined, custom.factory);
    void fromEnv.start('http://localhost:5173').catch(() => undefined);
    expect(vi.mocked(custom.factory).mock.calls[0]![0]).toBe('C:/tools/cloudflared.exe');
    fromEnv.stop();
  });
});

describe('gateway forwarding', () => {
  it('treats a request without a URL as the root of the frontend', async () => {
    const seen: (string | undefined)[] = [];
    const frontend = await listen(
      createServer((req, res) => {
        seen.push(req.url);
        res.writeHead(200).end('root');
      }),
    );
    const gateway = createLocalGateway(frontend, TOKEN);
    const incoming = Object.assign(Readable.from([]), {
      headers: AUTH,
      method: 'GET',
      url: undefined,
    });
    const writeHead = vi.fn();
    const outgoing = Object.assign(new PassThrough(), { writeHead, headersSent: false });
    gateway.emit('request', incoming, outgoing);
    await vi.waitFor(() => expect(writeHead).toHaveBeenCalledWith(200, expect.any(Object)));
    expect(seen).toEqual(['/']);
  });

  it('forwards to a loopback HTTPS service without verifying its local certificate', async () => {
    const api = await listen(createServer((_req, res) => res.writeHead(200).end('secure')));
    const gateway = await listen(
      createLocalGateway(await listen(createServer((_req, res) => res.end())), TOKEN),
    );
    vi.mocked(httpsRequest).mockImplementationOnce(((
      url: URL,
      options: RequestOptions,
      callback: Parameters<typeof httpRequest>[2],
    ) => httpRequest(new URL(url.href.replace('https:', 'http:')), options, callback)) as never);
    const secure = api.replace('http:', 'https:');
    expect(await rawStatus(gateway, `/_adk/local/${encoded(secure)}/health`)).toBe(200);
    const [url, options] = vi.mocked(httpsRequest).mock.calls[0]! as unknown as [
      URL,
      RequestOptions,
    ];
    expect(url.href).toBe(`${secure}/health`);
    expect((options as { rejectUnauthorized?: boolean }).rejectUnauthorized).toBe(false);
  });

  it('answers 502 when the service replies without a status', async () => {
    const gateway = await listen(
      createLocalGateway(await listen(createServer((_req, res) => res.end())), TOKEN),
    );
    vi.mocked(httpsRequest).mockImplementationOnce(((
      _url: URL,
      _options: RequestOptions,
      callback: (response: Readable) => void,
    ) => {
      const outgoing = new PassThrough();
      outgoing.on('finish', () => callback(Object.assign(Readable.from(['x']), { headers: {} })));
      return outgoing;
    }) as never);
    expect(await rawStatus(gateway, `/_adk/local/${encoded('https://localhost:9')}/x`)).toBe(502);
  });

  it('drops the connection when the request fails after the service started answering', async () => {
    const gateway = await listen(
      createLocalGateway(await listen(createServer((_req, res) => res.end())), TOKEN),
    );
    vi.mocked(httpsRequest).mockImplementationOnce(((
      _url: URL,
      _options: RequestOptions,
      callback: (response: Readable) => void,
    ) => {
      const outgoing = new PassThrough();
      outgoing.on('finish', () => {
        const response = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
        callback(response);
        response.write('partial');
        setTimeout(() => outgoing.emit('error', new Error('connection reset')), 20);
      });
      return outgoing;
    }) as never);
    const url = `${gateway}/_adk/local/${encoded('https://localhost:9')}/x`;
    const response = await fetch(url, { headers: AUTH });
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow('terminated');
  });
});

describe('fullstack tunnel lifecycle', () => {
  it('closes its gateway when cloudflared exits on its own', async () => {
    const { child, factory } = fakeProcess();
    const tunnel = new CloudflareTunnelManager('cloudflared', factory);
    const started = tunnel.start('http://localhost:5173', true);
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    const gatewayUrl = String(vi.mocked(factory).mock.calls[0]![1][2]);
    announce(child, 'exits');
    await started;
    expect(await rawStatus(gatewayUrl, '/')).toBe(403);
    child.emit('exit', 0);
    expect(tunnel.status()).toBeUndefined();
    await expect(rawStatus(gatewayUrl, '/')).rejects.toThrow();
  });

  it('does not start a tunnel when stopped while the URL was arriving', async () => {
    const { child, factory } = fakeProcess();
    const tunnel = new CloudflareTunnelManager('cloudflared', factory);
    const started = tunnel.start('http://localhost:5173', true);
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    announce(child, 'late');
    tunnel.stop();
    await expect(started).rejects.toThrow('Tunnel stopped.');
    expect(tunnel.status()).toBeUndefined();
  });

  it('fails when the gateway has no port to report', async () => {
    const { factory } = fakeProcess();
    const tunnel = new CloudflareTunnelManager('cloudflared', factory);
    vi.spyOn(NetServer.prototype, 'address').mockReturnValueOnce(null);
    await expect(tunnel.start('http://localhost:5173', true)).rejects.toThrow(
      'Gateway port unavailable.',
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it('ignores errors of a process that already gave its URL', async () => {
    const { child, factory } = fakeProcess();
    const tunnel = new CloudflareTunnelManager('cloudflared', factory);
    const started = tunnel.start('http://localhost:5173');
    announce(child, 'steady');
    const info = await started;
    child.emit('error', new Error('late failure'));
    expect(tunnel.status()).toBe(info);
  });
});
