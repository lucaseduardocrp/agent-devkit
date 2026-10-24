import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { remoteTargetGuard } from '../src/modules/apitests/application/target-guard.js';
import { runnerConfig } from '../src/modules/e2e/adapters/playwright-runner.js';
import {
  chromiumHostArgs,
  hostAccessFetch,
  hostAliasFromEnv,
  isLoopbackName,
} from '../src/shared/host-access.js';

describe('hostAliasFromEnv', () => {
  it('is off unless asked for: development and the cloud set nothing', () => {
    expect(hostAliasFromEnv({})).toBeNull();
    expect(hostAliasFromEnv({ ADK_HOST_ACCESS: 'false' })).toBeNull();
    expect(hostAliasFromEnv({ ADK_HOST_ACCESS: 'nonsense' })).toBeNull();
  });

  it('is on when asked for, with Docker host alias by default or the one given', () => {
    expect(hostAliasFromEnv({ ADK_HOST_ACCESS: 'true' })).toBe('host.docker.internal');
    expect(hostAliasFromEnv({ ADK_HOST_ACCESS: ' TRUE ', ADK_HOST_ALIAS: 'gateway' })).toBe(
      'gateway',
    );
  });

  it('in auto mode, is on only while ADK is reachable from this computer alone', () => {
    expect(hostAliasFromEnv({ ADK_HOST_ACCESS: 'auto' })).toBe('host.docker.internal');
    expect(hostAliasFromEnv({ ADK_HOST_ACCESS: 'auto', ADK_BIND_ADDRESS: '127.0.0.1' })).toBe(
      'host.docker.internal',
    );
    // Opened to the network, the host is a server other people use: its services stay closed.
    expect(hostAliasFromEnv({ ADK_HOST_ACCESS: 'auto', ADK_BIND_ADDRESS: '0.0.0.0' })).toBeNull();
    expect(
      hostAliasFromEnv({ ADK_HOST_ACCESS: 'auto', ADK_BIND_ADDRESS: '192.168.1.10' }),
    ).toBeNull();
  });

  it('knows the names of this machine', () => {
    for (const name of ['localhost', 'LOCALHOST', '127.0.0.1', '[::1]', '::1']) {
      expect(isLoopbackName(name)).toBe(true);
    }
    for (const name of ['example.com', '127.0.0.2', 'localhost.example.com', '10.0.0.1']) {
      expect(isLoopbackName(name)).toBe(false);
    }
  });
});

describe('Chromium host rules', () => {
  it('maps localhost and 127.0.0.1 to the alias, and nothing when off', () => {
    expect(chromiumHostArgs('host.docker.internal')).toEqual([
      '--host-resolver-rules=MAP localhost host.docker.internal, MAP 127.0.0.1 host.docker.internal',
    ]);
    expect(chromiumHostArgs(null)).toEqual([]);
  });

  it('goes into the Playwright config of a run only when given', () => {
    const args = chromiumHostArgs('host.docker.internal');
    const withArgs = runnerConfig('http://localhost:5173', 'pt-BR', false, false, args);
    expect(withArgs).toContain(`args: ${JSON.stringify(args)}`);
    expect(runnerConfig('http://localhost:5173', 'pt-BR')).not.toContain('args:');
  });
});

describe('remoteTargetGuard with host access', () => {
  it('lets localhost through, since it goes to the user computer', async () => {
    const guard = remoteTargetGuard({ hostAlias: 'host.docker.internal' });
    await expect(guard(new URL('http://localhost:5000/api'))).resolves.toBeUndefined();
    await expect(guard(new URL('http://127.0.0.1:5000/'))).resolves.toBeUndefined();
    await expect(guard(new URL('http://[::1]:5000/'))).resolves.toBeUndefined();
  });

  it('opens the private network, which is where the user computer is', async () => {
    const guard = remoteTargetGuard({ hostAlias: 'host.docker.internal' });
    await expect(guard(new URL('http://192.168.1.20/'))).resolves.toBeUndefined();
    await expect(guard(new URL('http://10.1.2.3/'))).resolves.toBeUndefined();
  });

  it('still blocks the cloud metadata endpoint and other loopback addresses', async () => {
    const guard = remoteTargetGuard({ hostAlias: 'host.docker.internal' });
    await expect(guard(new URL('http://169.254.169.254/latest'))).rejects.toMatchObject({
      code: 'API_TEST_TARGET_LOCAL',
    });
    // Only the names above are sent to the alias; another loopback address is the container.
    await expect(guard(new URL('http://127.0.0.2/'))).rejects.toMatchObject({
      code: 'API_TEST_TARGET_LOCAL',
    });
  });

  it('keeps blocking localhost without host access, as before', async () => {
    const guard = remoteTargetGuard({});
    await expect(guard(new URL('http://localhost:5000/'))).rejects.toMatchObject({
      code: 'API_TEST_TARGET_LOCAL',
    });
    await expect(guard(new URL('http://192.168.1.20/'))).rejects.toMatchObject({
      code: 'API_TEST_TARGET_LOCAL',
    });
  });
});

describe('hostAccessFetch', () => {
  let server: http.Server | undefined;
  afterEach(
    () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())),
  );

  /** A server on 127.0.0.2 only: a request that reaches it went through the alias, not loopback. */
  async function aliasServer(): Promise<{ port: number; hosts: string[] } | null> {
    const hosts: string[] = [];
    server = http.createServer((request, response) => {
      hosts.push(request.headers.host ?? '');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ method: request.method, path: request.url }));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(0, '127.0.0.2', resolve);
      });
    } catch {
      server = undefined;
      return null; // 127.0.0.2 is not configured here (macOS by default)
    }
    return { port: (server.address() as AddressInfo).port, hosts };
  }

  it('sends localhost to the alias and keeps the Host header localhost', async (context) => {
    const target = await aliasServer();
    if (!target) return context.skip();
    const fetcher = hostAccessFetch('127.0.0.2');
    const response = await fetcher(new URL(`http://localhost:${target.port}/orders?page=2`), {
      method: 'POST',
      body: '{}',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ method: 'POST', path: '/orders?page=2' });
    expect(target.hosts).toEqual([`localhost:${target.port}`]);
  });

  it('sends the 127.0.0.1 literal there too, as localhost', async (context) => {
    const target = await aliasServer();
    if (!target) return context.skip();
    const response = await hostAccessFetch('127.0.0.2')(`http://127.0.0.1:${target.port}/x`);
    expect(response.status).toBe(200);
    expect(target.hosts).toEqual([`localhost:${target.port}`]);
  });

  it('leaves other hosts alone', async (context) => {
    const target = await aliasServer();
    if (!target) return context.skip();
    const response = await hostAccessFetch('203.0.113.1')(`http://127.0.0.2:${target.port}/`);
    expect(response.status).toBe(200);
    expect(target.hosts).toEqual([`127.0.0.2:${target.port}`]);
  });
});
