import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createLocalTunnelBridge } from '../src/e2e/local-bridge.js';

const ORIGIN = 'https://adk.example.com';
let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe('local tunnel bridge', () => {
  it('allows only the configured frontend origin and loopback Host to control the tunnel', async () => {
    const tunnel = {
      start: vi.fn(async (localUrl: string) => ({
        localUrl,
        publicUrl: 'https://test.trycloudflare.com',
      })),
      status: vi.fn(() => undefined),
      stop: vi.fn(),
    };
    server = createLocalTunnelBridge(ORIGIN, tunnel, 0);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const rejected = await fetch(`${url}/tunnel`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example.com', 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://localhost:5173' }),
    });
    expect(rejected.status).toBe(403);
    expect(tunnel.start).not.toHaveBeenCalled();

    const otherFrontend = await fetch(`${url}/status`, {
      headers: { Origin: 'https://staging.example.com' },
    });
    expect(otherFrontend.status).toBe(403);
    expect(otherFrontend.headers.get('access-control-allow-origin')).toBe(
      'https://staging.example.com',
    );
    expect(await otherFrontend.json()).toMatchObject({ code: 'origin_mismatch' });
    expect(tunnel.status).not.toHaveBeenCalled();

    const preflight = await fetch(`${url}/tunnel`, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Private-Network': 'true' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-private-network')).toBe('true');

    const started = await fetch(`${url}/tunnel`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://localhost:5173' }),
    });
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({
      tunnel: { localUrl: 'http://localhost:5173', publicUrl: 'https://test.trycloudflare.com' },
    });
    expect(tunnel.start).toHaveBeenCalledWith('http://localhost:5173', true);

    const stopped = await fetch(`${url}/tunnel`, { method: 'DELETE', headers: { Origin: ORIGIN } });
    expect(stopped.status).toBe(200);
    expect(tunnel.stop).toHaveBeenCalledOnce();
  });
});
