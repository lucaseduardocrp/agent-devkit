import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { ApiTestWorker } from '../src/modules/apitests/application/api-test-worker.js';
import { refs, strip } from '../src/modules/apitests/application/personal-secrets.js';
import { CookieJar } from '../src/modules/apitests/engine/cookie-jar.js';
import type { CollectionSpec, RequestAuth } from '../src/modules/apitests/engine/types.js';
import { LayeredScope } from '../src/modules/apitests/engine/variables.js';
import type { ApiRun } from '../src/modules/apitests/domain/api-test.js';

describe('ApiTestWorker defaults', () => {
  const integrationPayload = (...urls: string[]) => ({
    kind: 'integration' as const,
    collection: {
      name: 'C',
      variables: [],
      auth: { type: 'none' as const },
      items: urls.map((url, index) => ({
        id: `r${index}`,
        type: 'request' as const,
        name: 'a',
        method: 'GET' as const,
        url,
        headers: [],
        query: [],
        body: { mode: 'none' as const },
        auth: { type: 'inherit' as const },
        assertions: [],
        captures: [],
      })),
    },
    environment: [],
    itemIds: [],
    bail: false,
  });

  const serviceFor = (payload: unknown) => ({
    sweep: vi.fn(() => Promise.resolve({ requeued: 0, failed: 0 })),
    claimRemote: vi
      .fn()
      .mockResolvedValueOnce({ id: 'r1' } as ApiRun)
      .mockResolvedValue(null),
    payloadOf: vi.fn(() => payload as never),
    heartbeat: vi.fn(() => Promise.resolve('running' as never)),
    finish: vi.fn(() => Promise.resolve()),
  });

  it('uses the default heartbeat and the injected fetch and guard', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('ok', { status: 200 })));
    const guard = vi.fn(() => Promise.resolve());
    const service = serviceFor(integrationPayload('https://api.example.test/a'));
    const worker = new ApiTestWorker({
      service: service as never,
      fetch: fetchSpy as never,
      guard,
    });
    worker.wake();
    await worker.idle();
    expect(guard).toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalled();
    expect(service.finish).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r1' }),
      worker.workerId,
      expect.objectContaining({ status: expect.any(String) }),
    );
  });

  it('sends localhost requests to the host alias when host access is on', async () => {
    const hosts: string[] = [];
    const server = http.createServer((request, response) => {
      hosts.push(String(request.headers.host));
      response.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const service = serviceFor(
        integrationPayload(`http://localhost:${port}/a`, `http://127.0.0.2:${port}/b`),
      );
      const worker = new ApiTestWorker({
        service: service as never,
        hostAlias: '127.0.0.1',
        guard: () => Promise.resolve(),
      });
      worker.wake();
      await worker.idle();
      expect(hosts).toEqual([`localhost:${port}`, `127.0.0.2:${port}`]);
      expect(service.finish).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'r1' }),
        worker.workerId,
        expect.objectContaining({ status: 'passed' }),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('personal-secrets with unknown auth types', () => {
  it('leaves an auth type without secret fields untouched', () => {
    const auth = { type: 'legacy', token: 'abc' } as unknown as RequestAuth;
    const collection = { name: 'C', variables: [], auth, items: [] } as CollectionSpec;
    expect(refs(collection)).toEqual([]);
    expect(strip(collection).shared.auth).toEqual(auth);
  });
});

describe('CookieJar edges', () => {
  const T0 = Date.UTC(2025, 0, 1);
  const jar = () => new CookieJar([], () => T0);

  it('normalizes a set cookie whose path is not absolute', () => {
    const cookies = jar();
    cookies.set({ name: 'a', value: '1', domain: '.Example.com', path: 'x' } as never);
    expect(cookies.all()).toMatchObject([{ name: 'a', domain: 'example.com', path: '/' }]);
  });

  it('handles URLs with an empty or opaque path', () => {
    const cookies = jar();
    expect(cookies.cookieHeader(new URL('foo://host'))).toBeUndefined();
    cookies.store(new URL('foo:opaque'), ['a=1']);
    expect(cookies.all()).toMatchObject([{ name: 'a', path: '/' }]);
  });

  it('ignores a Path attribute that is not absolute and keeps an empty SameSite as unset', () => {
    const cookies = jar();
    cookies.store(new URL('https://example.com/a/b'), ['a=1; Path=relative; SameSite']);
    const [cookie] = cookies.all();
    expect(cookie).toMatchObject({ name: 'a', path: '/a' });
    expect(cookie?.sameSite).toBeUndefined();
  });
});

describe('LayeredScope edges', () => {
  it('reports a secret that is defined in any layer', () => {
    const scope = new LayeredScope({
      collection: [{ key: 'token', value: 'abc', secret: true }],
      environment: [{ key: 'other', value: 'x' }],
    });
    expect(scope.isSecret('token')).toBe(true);
    expect(scope.isSecret('other')).toBe(false);
    expect(scope.isSecret('missing')).toBe(false);
    scope.setIn('runtime', 'token', 'new');
    expect(scope.get('token')).toEqual({ value: 'new', secret: true });
  });

  it('skips disabled and unnamed rows when assigning a layer', () => {
    const scope = new LayeredScope();
    scope.assign('request', [
      { key: 'a', value: '1', enabled: true },
      { key: 'off', value: '2', enabled: false },
      { key: '   ', value: '3' },
    ]);
    expect(scope.record('request')).toEqual({ a: '1' });
  });
});
