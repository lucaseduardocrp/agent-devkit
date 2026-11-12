import type { Server } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalTunnelBridge } from '../src/e2e/local-bridge.js';

const ORIGIN = 'https://adk.example.com';
let server: Server | undefined;

afterEach(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function listen(tunnel: Parameters<typeof createLocalTunnelBridge>[1]) {
  server = createLocalTunnelBridge(ORIGIN, tunnel, 0);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('local tunnel bridge branches', () => {
  it('reports a failure that is not an Error with a generic message', async () => {
    const url = await listen({
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- covers a non-Error rejection
      start: () => Promise.reject('refused'),
      status: () => undefined,
      stop: vi.fn(),
    });
    const response = await fetch(`${url}/tunnel`, {
      method: 'POST',
      headers: { Origin: ORIGIN },
      body: JSON.stringify({ url: 'http://localhost:5173' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Could not start tunnel.' });
  });

  it('drops the connection when the answer cannot be written after its headers went out', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const url = await listen({
      start: vi.fn(),
      status: () => circular as never,
      stop: vi.fn(),
    });
    await expect(fetch(`${url}/status`, { headers: { Origin: ORIGIN } })).rejects.toThrow();
  });

  it('expects its configured port as the Host while it is not listening', () => {
    const bridge = createLocalTunnelBridge(
      ORIGIN,
      { start: vi.fn(), status: () => undefined, stop: vi.fn() },
      9999,
    );
    const request = Object.assign(Readable.from([]), {
      headers: { host: '127.0.0.1:9999', origin: ORIGIN },
      method: 'GET',
      url: '/status',
    });
    const writeHead = vi.fn();
    const response = {
      setHeader: vi.fn(),
      writeHead,
      end: vi.fn(),
      headersSent: false,
    };
    bridge.emit('request', request, response);
    return vi.waitFor(() => expect(writeHead).toHaveBeenCalledWith(200, expect.any(Object)));
  });
});
