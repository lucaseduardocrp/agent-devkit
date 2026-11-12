import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';

const lookups: string[] = [];

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    // Names of this test resolve to the local machine; the lookups are recorded.
    lookup: (hostname: string, ...rest: unknown[]) => {
      lookups.push(hostname);
      const target = hostname.endsWith('.adk-test') ? '127.0.0.1' : hostname;
      return (actual.lookup as (...args: unknown[]) => unknown)(target, ...rest);
    },
  };
});

const { hostAccessFetch } = await import('../src/shared/host-access.js');

describe('hostAccessFetch DNS lookups', () => {
  it('resolves other names as they are and sends loopback names to the host alias', async () => {
    const hosts: string[] = [];
    const server = http.createServer((request, response) => {
      hosts.push(String(request.headers.host));
      response.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const fetcher = hostAccessFetch('gateway.adk-test');
      await fetcher(`http://localhost:${port}/a`);
      await fetcher(`http://service.adk-test:${port}/b`);
      expect(lookups).toEqual(['gateway.adk-test', 'service.adk-test']);
      expect(hosts).toEqual([`localhost:${port}`, `service.adk-test:${port}`]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
