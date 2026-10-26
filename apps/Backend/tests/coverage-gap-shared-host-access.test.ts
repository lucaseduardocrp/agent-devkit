import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const looked: string[] = [];

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    // Every name resolves to this machine, so no request leaves it.
    lookup: (hostname: string, options: object, callback: (...args: unknown[]) => void) => {
      looked.push(hostname);
      actual.lookup('127.0.0.1', options as never, callback as never);
    },
  };
});

const { hostAccessFetch } = await import('../src/shared/host-access.js');

describe('hostAccessFetch connections', () => {
  let server: http.Server;
  let port: number;
  const hosts: string[] = [];
  beforeAll(async () => {
    server = http.createServer((request, response) => {
      hosts.push(request.headers.host ?? '');
      response.end(`${request.method} ${request.url}`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('resolves other names themselves and keeps a whole Request intact', async () => {
    const fetcher = hostAccessFetch('host.alias');
    const other = await fetcher(`http://api.example.test:${port}/a`);
    expect(await other.text()).toBe('GET /a');
    // Node's global Request, which undici's fetch would reject as is.
    const whole = await fetcher(
      new Request(`http://127.0.0.1:${port}/b`, { method: 'POST', body: 'x' }),
    );
    expect(await whole.text()).toBe('POST /b');
    expect(looked).toEqual(['api.example.test', 'host.alias']);
    expect(hosts).toEqual([`api.example.test:${port}`, `localhost:${port}`]);
  });
});
