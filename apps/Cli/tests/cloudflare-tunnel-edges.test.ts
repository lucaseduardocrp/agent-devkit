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
