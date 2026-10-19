import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  CloudflareTunnelManager,
  createLocalGateway,
  localOrigin,
  quickTunnelCommand,
} from '../src/modules/e2e/cloudflare-tunnel.js';

function fakeProcess() {
  const kill = vi.fn(() => {
    queueMicrotask(() => {
      child.emit('exit', 0);
      child.emit('close', 0);
    });
    return true;
  });
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill,
  }) as unknown as ChildProcessWithoutNullStreams;
  const factory = vi.fn(() => child) as unknown as typeof spawn;
  return { child, factory, kill };
}

describe('Cloudflare Tunnel', () => {
  it('forwards the frontend and a second local API with the same session key', async () => {
    const received: {
      host?: string;
      origin?: string;
      token?: string;
      forwardedHost?: string;
      body?: string;
    }[] = [];
    const frontend = createServer((_request, response) => response.writeHead(200).end('frontend'));
    const api = createServer((request, response) => {
      void (async () => {
        let body = '';
        for await (const chunk of request) body += String(chunk);
        received.push({
          host: request.headers.host,
          origin: request.headers.origin,
          token: String(request.headers['cf-access-client-secret'] ?? ''),
          forwardedHost: String(request.headers['x-forwarded-host'] ?? ''),
          body,
        });
        response
          .writeHead(200, {
            'content-type': 'application/json',
            'access-control-allow-origin': 'http://localhost:8014',
          })
          .end(JSON.stringify({ saved: true }));
      })().catch(() => response.writeHead(500).end());
    });
    const servers: Server[] = [frontend, api];
    const listen = async (server: Server) => {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    try {
      const frontendUrl = await listen(frontend);
      const apiUrl = await listen(api);
      const token = { clientId: 'adk-local-test', clientSecret: 'private-key' };
      const gateway = createLocalGateway(frontendUrl, token);
      servers.push(gateway);
      const gatewayUrl = await listen(gateway);
      expect((await fetch(gatewayUrl)).status).toBe(403);
      const headers = {
        'CF-Access-Client-Id': token.clientId,
        'CF-Access-Client-Secret': token.clientSecret,
        Origin: 'http://localhost:8014',
        'X-Forwarded-Host': 'public.trycloudflare.com',
      };
      expect(await (await fetch(gatewayUrl, { headers })).text()).toBe('frontend');
      const remote = `${gatewayUrl}/_adk/local/${Buffer.from(apiUrl).toString('base64url')}/api/save`;
      const response = await fetch(remote, { method: 'POST', headers, body: 'hello' });
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:8014');
      expect(await response.json()).toEqual({ saved: true });
      expect(received).toEqual([
        {
          host: new URL(apiUrl).host,
          origin: 'http://localhost:8014',
          token: '',
          forwardedHost: '',
          body: 'hello',
        },
      ]);
      const forbidden = await fetch(
        `${gatewayUrl}/_adk/local/${Buffer.from('https://example.com').toString('base64url')}/`,
        { headers },
      );
      expect(forbidden.status).toBe(403);
    } finally {
      await Promise.all(
        servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
    }
  });
  it('accepts only loopback HTTP origins', () => {
    expect(localOrigin('http://localhost:5173/login')).toBe('http://localhost:5173');
    expect(localOrigin('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(() => localOrigin('https://example.com')).toThrow('loopback');
    expect(() => localOrigin('http://user:pass@localhost:5173')).toThrow('loopback');
  });

  it('uses the local Host header for the public tunnel', () => {
    expect(quickTunnelCommand('http://localhost:5173/login')).toBe(
      'cloudflared tunnel --url http://localhost:5173 --http-host-header localhost:5173',
    );
  });

  it('starts once, reads the public URL and stops the child process', async () => {
    const { child, factory, kill } = fakeProcess();
    const tunnel = new CloudflareTunnelManager('cloudflared', factory);
    const pending = tunnel.start('http://localhost:5173/login');
    (child.stderr as PassThrough).write(
      'INF Visit https://sample.trycloudflare.com to view your tunnel\n',
    );
    await expect(pending).resolves.toEqual({
      localUrl: 'http://localhost:5173',
      publicUrl: 'https://sample.trycloudflare.com',
    });
    expect(factory).toHaveBeenCalledWith(
      'cloudflared',
      ['tunnel', '--url', 'http://localhost:5173', '--http-host-header', 'localhost:5173'],
      expect.any(Object),
    );
    await expect(tunnel.start('http://localhost:5173')).resolves.toEqual(tunnel.status());
    expect(factory).toHaveBeenCalledTimes(1);
    await expect(tunnel.start('http://localhost:8080')).rejects.toThrow('already running');
    tunnel.stop();
    expect(kill).toHaveBeenCalledOnce();
    expect(tunnel.status()).toBeUndefined();
  });

  it('opens a protected local gateway when started for a fullstack application', async () => {
    const frontend = createServer((_request, response) => response.writeHead(200).end('ready'));
    await new Promise<void>((resolve) => frontend.listen(0, '127.0.0.1', resolve));
    const frontendUrl = `http://127.0.0.1:${(frontend.address() as AddressInfo).port}`;
    const { child, factory } = fakeProcess();
    const tunnel = new CloudflareTunnelManager('cloudflared', factory);
    try {
      const pending = tunnel.start(frontendUrl, true);
      await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
      (child.stderr as PassThrough).write('INF Visit https://fullstack.trycloudflare.com\n');
      const info = await pending;
      expect(info.localUrl).toBe(frontendUrl);
      expect(info.accessClientId).toMatch(/^adk-local-/);
      expect(info.accessClientSecret).toHaveLength(64);
      const gatewayUrl = String(vi.mocked(factory).mock.calls[0]?.[1]?.[2]);
      expect((await fetch(gatewayUrl)).status).toBe(403);
      expect(
        await (
          await fetch(gatewayUrl, {
            headers: {
              'CF-Access-Client-Id': info.accessClientId!,
              'CF-Access-Client-Secret': info.accessClientSecret!,
            },
          })
        ).text(),
      ).toBe('ready');
    } finally {
      tunnel.stop();
      await new Promise<void>((resolve) => frontend.close(() => resolve()));
    }
  });

  it('reports a missing cloudflared binary and releases the target', async () => {
    const { child, factory } = fakeProcess();
    const tunnel = new CloudflareTunnelManager('missing', factory);
    const pending = tunnel.start('http://localhost:5173');
    child.emit('error', new Error('ENOENT'));
    await expect(pending).rejects.toThrow('Install cloudflared');
    expect(tunnel.status()).toBeUndefined();
  });

  it('cancels startup when stopped before a URL is returned', async () => {
    const { factory, kill } = fakeProcess();
    const tunnel = new CloudflareTunnelManager('cloudflared', factory);
    const pending = tunnel.start('http://localhost:5173');
    tunnel.stop();
    await expect(pending).rejects.toThrow('Tunnel stopped');
    expect(kill).toHaveBeenCalledOnce();
    expect(tunnel.status()).toBeUndefined();
  });

  it('cancels a fullstack gateway before the tunnel process starts', async () => {
    const { factory } = fakeProcess();
    const tunnel = new CloudflareTunnelManager('cloudflared', factory);
    const pending = tunnel.start('http://localhost:5173', true);
    tunnel.stop();
    await expect(pending).rejects.toThrow('Tunnel stopped');
    expect(factory).not.toHaveBeenCalled();
    expect(tunnel.status()).toBeUndefined();
  });
});
