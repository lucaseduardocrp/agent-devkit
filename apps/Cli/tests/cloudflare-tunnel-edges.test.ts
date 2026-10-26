import { EventEmitter } from 'node:events';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudflareTunnelManager, createLocalGateway } from '../src/e2e/cloudflare-tunnel.js';

const TOKEN = { clientId: 'adk-local-test', clientSecret: 'private-key' };
const AUTH = {
  'cf-access-client-id': TOKEN.clientId,
  'cf-access-client-secret': TOKEN.clientSecret,
};
const servers: Server[] = [];

afterEach(async () => {
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

/** Sends the path exactly as given (fetch would normalize it). */
function rawStatus(base: string, path: string, headers: Record<string, string> = AUTH) {
  return new Promise<number>((resolve, reject) => {
    const outgoing = request(`${base}/`, { path, headers }, (response) => {
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

describe('local gateway edges', () => {
  it('accepts only a loopback frontend', () => {
    expect(() => createLocalGateway('https://example.com', TOKEN)).toThrow('loopback');
    expect(() => createLocalGateway('not a url', TOKEN)).toThrow('loopback');
    expect(() => createLocalGateway('http://user:pw@localhost:5173', TOKEN)).toThrow('loopback');
  });

  it('rejects wrong keys, malformed routes and requests that leave the allowed origin', async () => {
    const frontend = await listen(createServer((_req, res) => res.writeHead(200).end()));
    const gateway = await listen(createLocalGateway(frontend, TOKEN));
    expect(
      await rawStatus(gateway, '/', { ...AUTH, 'cf-access-client-secret': 'wrong-key!!' }),
    ).toBe(403);
    expect(await rawStatus(gateway, '/', { 'cf-access-client-id': TOKEN.clientId })).toBe(403);
    expect(await rawStatus(gateway, '/_adk/local/no-slash')).toBe(400);
    expect(await rawStatus(gateway, `/_adk/local/${encoded(frontend)}=/`)).toBe(400);
    expect(await rawStatus(gateway, `/_adk/local/${encoded(`${frontend}/path`)}/`)).toBe(403);
    expect(await rawStatus(gateway, `/_adk/local/${encoded(frontend)}//example.com/x`)).toBe(403);
    expect(await rawStatus(gateway, '//example.com/x')).toBe(403);
    expect(await rawStatus(gateway, 'http://[')).toBe(400);
    expect(await rawStatus(gateway, '/')).toBe(200);
  });

  it('answers 502 when the local service is down', async () => {
    const stopped = createServer();
    const address = await listen(stopped);
    await new Promise<void>((resolve) => stopped.close(() => resolve()));
    const gateway = await listen(createLocalGateway(address, TOKEN));
    expect(await rawStatus(gateway, '/')).toBe(502);
  });
});

describe('tunnel manager edges', () => {
  it('shares a pending start, reuses a running tunnel and refuses another target', async () => {
    const { child, factory } = fakeProcess();
    const tunnel = new CloudflareTunnelManager('cloudflared', factory);
    const first = tunnel.start('http://localhost:5173');
    const second = tunnel.start('http://localhost:5173/other');
    (child.stdout as PassThrough).write('https://shared.trycloudflare.com\n');
    const info = await first;
    expect(await second).toBe(info);
    expect(await tunnel.start('http://localhost:5173')).toBe(info);
    expect(factory).toHaveBeenCalledOnce();
    await expect(tunnel.start('http://localhost:3000')).rejects.toThrow('already running');
  });

  it('waits for the process to close and forgets a tunnel whose process exits', async () => {
    const { child, factory } = fakeProcess();
    const tunnel = new CloudflareTunnelManager('cloudflared', factory);
    await expect(tunnel.waitForClose()).resolves.toBeUndefined();
    const started = tunnel.start('http://localhost:5173');
    (child.stderr as PassThrough).write('INF https://gone.trycloudflare.com\n');
    await started;
    const closed = tunnel.waitForClose();
    child.emit('exit', 1);
    child.emit('close', 1);
    await closed;
    expect(tunnel.status()).toBeUndefined();
  });

  it('reports a process that exits before printing a URL, with its logs', async () => {
    const { child, factory } = fakeProcess();
    const tunnel = new CloudflareTunnelManager('cloudflared', factory);
    const started = tunnel.start('http://localhost:5173');
    (child.stderr as PassThrough).write('ERR failed to connect\n');
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('exit', 1);
    await expect(started).rejects.toThrow(/code 1\)\. ERR failed to connect/);
    expect(tunnel.status()).toBeUndefined();
  });

  it('gives up when cloudflared prints no URL within 45 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { factory } = fakeProcess();
      const tunnel = new CloudflareTunnelManager('cloudflared', factory);
      const started = tunnel.start('http://localhost:5173');
      const outcome = expect(started).rejects.toThrow('did not provide a URL within 45 seconds');
      await vi.advanceTimersByTimeAsync(45_000);
      await outcome;
      expect(tunnel.status()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the fullstack gateway when cloudflared cannot start', async () => {
    const { child, factory } = fakeProcess();
    const tunnel = new CloudflareTunnelManager('cloudflared', factory);
    const started = tunnel.start('http://localhost:5173', true);
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    child.emit('error', new Error('ENOENT'));
    await expect(started).rejects.toThrow('Could not start cloudflared');
    const retry = tunnel.start('http://localhost:3000', true);
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
    tunnel.stop();
    await expect(retry).rejects.toThrow('Tunnel stopped.');
  });
});

describe('local gateway forwarding edges', () => {
  it('forwards to HTTPS loopback services and answers 502 when they are down', async () => {
    const stopped = createServer();
    const address = await listen(stopped);
    await new Promise<void>((resolve) => stopped.close(() => resolve()));
    const gateway = await listen(createLocalGateway(address.replace('http:', 'https:'), TOKEN));
    expect(await rawStatus(gateway, '/')).toBe(502);
  });

  it('drops the response when the local service stalls after sending its headers', async () => {
    const frontend = await listen(
      createServer((_req, res) => {
        res.writeHead(200, { 'content-length': '100' });
        res.write('partial');
      }),
    );
    const gateway = await listen(createLocalGateway(frontend, TOKEN, 50));
    const failure = await new Promise<string>((resolve) => {
      const outgoing = request(`${gateway}/`, { headers: AUTH }, (response) => {
        response.once('error', (error) => resolve(error.message));
        response.resume();
      });
      outgoing.once('error', (error) => resolve(error.message));
      outgoing.end();
    });
    expect(failure).toMatch(/aborted|ECONNRESET|socket hang up/);
  });
});

describe('tunnel manager startup edges', () => {
  it('accepts only HTTP loopback targets', async () => {
    const tunnel = new CloudflareTunnelManager('cloudflared', fakeProcess().factory);
    await expect(tunnel.start('::not a url')).rejects.toThrow('Enter a local URL');
    for (const target of [
      'https://localhost:5173',
      'http://example.com',
      'http://user@localhost:5173',
      'http://:pw@localhost:5173',
      'http://localhost:5173/?q=1',
      'http://localhost:5173/#top',
    ]) {
      await expect(tunnel.start(target)).rejects.toThrow('HTTP loopback URL');
    }
  });

  it('runs the cloudflared from ADK_CLOUDFLARED_PATH, or the one on the PATH', async () => {
    vi.stubEnv('ADK_CLOUDFLARED_PATH', '/opt/cloudflared');
    try {
      const custom = new CloudflareTunnelManager();
      await expect(custom.waitForClose()).resolves.toBeUndefined();
      expect((custom as unknown as { executable: string }).executable).toBe('/opt/cloudflared');
      vi.stubEnv('ADK_CLOUDFLARED_PATH', '');
      expect((new CloudflareTunnelManager() as unknown as { executable: string }).executable).toBe(
        'cloudflared',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('gives up a fullstack start stopped before or right after cloudflared answers', async () => {
    const { child, factory } = fakeProcess();
    const tunnel = new CloudflareTunnelManager('cloudflared', factory);
    const beforeLaunch = tunnel.start('http://localhost:5173', true);
    tunnel.stop();
    await expect(beforeLaunch).rejects.toThrow('Tunnel stopped.');
    expect(factory).not.toHaveBeenCalled();

    const afterLaunch = tunnel.start('http://localhost:5173', true);
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    child.stdout.emit('data', Buffer.from('https://late.trycloudflare.com\n'));
    tunnel.stop();
    await expect(afterLaunch).rejects.toThrow('Tunnel stopped.');
    expect(tunnel.status()).toBeUndefined();
  });

  it('ignores late process errors and closes the gateway when a fullstack tunnel exits', async () => {
    const { child, factory } = fakeProcess();
    const tunnel = new CloudflareTunnelManager('cloudflared', factory);
    const started = tunnel.start('http://localhost:5173', true);
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    (child.stdout as PassThrough).write('https://full.trycloudflare.com\n');
    const info = await started;
    expect(info).toMatchObject({
      localUrl: 'http://localhost:5173',
      accessClientId: expect.any(String),
    });
    child.emit('error', new Error('late'));
    expect(tunnel.status()).toBe(info);
    const gateway = (tunnel as unknown as { gateway: Server }).gateway;
    child.emit('exit', 0);
    expect(gateway.listening).toBe(false);
    expect(tunnel.status()).toBeUndefined();
  });
});
