import { request, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalTunnelBridge } from '../src/e2e/local-bridge.js';

const ORIGIN = 'https://adk.example.com';
let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

function fakeTunnel() {
  return {
    start: vi.fn((localUrl: string) =>
      localUrl === 'http://localhost:1'
        ? Promise.reject(new Error('cloudflared missing'))
        : Promise.resolve({ localUrl, publicUrl: 'https://t.trycloudflare.com' }),
    ),
    status: vi.fn((): undefined => undefined),
    stop: vi.fn(),
  };
}

async function start(tunnel = fakeTunnel()) {
  server = createLocalTunnelBridge(ORIGIN, tunnel, 0);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { tunnel, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

const post = (url: string, body: string) =>
  fetch(`${url}/tunnel`, { method: 'POST', headers: { Origin: ORIGIN }, body });

describe('local tunnel bridge edges', () => {
  it('accepts only an HTTPS (or localhost) frontend origin without a path', () => {
    expect(() => createLocalTunnelBridge('http://adk.example.com', fakeTunnel())).toThrow('HTTPS');
    expect(() => createLocalTunnelBridge(`${ORIGIN}/app`, fakeTunnel())).toThrow('only the ADK');
    expect(() => createLocalTunnelBridge('http://localhost:5173', fakeTunnel())).not.toThrow();
  });

  it('rejects a foreign Host header and requests without an Origin', async () => {
    const { url } = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = request(
        `${url}/status`,
        { headers: { host: 'attacker.example:8765', origin: ORIGIN } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      outgoing.once('error', reject);
      outgoing.end();
    });
    expect(status).toBe(403);
    const anonymous = await fetch(`${url}/status`);
    expect(anonymous.status).toBe(403);
    expect(anonymous.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('reports the status, unknown routes and invalid tunnel requests', async () => {
    const { url, tunnel } = await start();
    const status = await fetch(`${url}/status`, { headers: { Origin: ORIGIN } });
    expect(await status.json()).toEqual({ tunnel: null });
    expect((await fetch(`${url}/other`, { headers: { Origin: ORIGIN } })).status).toBe(404);
    expect(await (await post(url, 'not json')).json()).toHaveProperty('error');
    expect(await (await post(url, '{}')).json()).toEqual({ error: 'Enter a local URL.' });
    expect(await (await post(url, 'x'.repeat(2048))).json()).toEqual({
      error: 'Request is too large.',
    });
    const failed = await post(url, JSON.stringify({ url: 'http://localhost:1' }));
    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual({ error: 'cloudflared missing' });
    expect(tunnel.start).toHaveBeenCalledOnce();
  });

  it('answers 500 when the tunnel fails unexpectedly', async () => {
    const tunnel = fakeTunnel();
    tunnel.status.mockImplementation(() => {
      throw new Error('boom');
    });
    const { url } = await start(tunnel);
    expect((await fetch(`${url}/status`, { headers: { Origin: ORIGIN } })).status).toBe(500);
  });
});
