import { describe, expect, it, vi } from 'vitest';
import { probeTunnel } from '../src/modules/e2e/application/tunnel-probe.js';

const publicDns = vi.fn(async () => [{ address: '104.16.1.1', family: 4 as const }]);

describe('E2E tunnel check', () => {
  it('checks the public endpoint with its DNS address pinned', async () => {
    const request = vi.fn(async () => ({ status: 200, location: '' }));
    await expect(
      probeTunnel('https://sample.trycloudflare.com/login', publicDns, request),
    ).resolves.toEqual({
      reachable: true,
      reason: 'ok',
      status: 200,
    });
    expect(request).toHaveBeenCalledWith(
      new URL('https://sample.trycloudflare.com/login'),
      {
        address: '104.16.1.1',
        family: 4,
      },
      {},
    );
  });

  it('distinguishes access challenges and an unavailable local origin', async () => {
    const response = async (status: number, location = '') =>
      probeTunnel('https://app.example.com', publicDns, async () => ({ status, location }));
    await expect(response(403)).resolves.toMatchObject({
      reachable: false,
      reason: 'authentication',
    });
    await expect(response(302, '/cdn-cgi/access/login')).resolves.toMatchObject({
      reachable: false,
      reason: 'authentication',
    });
    await expect(response(502)).resolves.toMatchObject({
      reachable: false,
      reason: 'origin_error',
    });
    await expect(response(404)).resolves.toMatchObject({ reachable: true, reason: 'ok' });
  });

  it('rejects an Invalid Host header page even when the server returns HTTP 200', async () => {
    await expect(
      probeTunnel('https://sample.trycloudflare.com', publicDns, async () => ({
        status: 200,
        location: '',
        body: '<!doctype html><html><body>Invalid Host header</body></html>',
      })),
    ).resolves.toEqual({ reachable: false, reason: 'host_error', status: 200 });
  });

  it('refuses local destinations and private DNS answers', async () => {
    await expect(probeTunnel('http://localhost:5173')).rejects.toMatchObject({ statusCode: 400 });
    await expect(probeTunnel('https://127.0.0.1')).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      probeTunnel('https://app.example.com', async () => [
        { address: '104.16.1.1', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ]),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('reports network failures without exposing connection details', async () => {
    await expect(
      probeTunnel('https://app.example.com', async () => {
        throw new Error('dns');
      }),
    ).resolves.toEqual({
      reachable: false,
      reason: 'network_error',
      status: null,
    });
    await expect(
      probeTunnel('https://app.example.com', publicDns, async () => {
        throw new Error('network');
      }),
    ).resolves.toEqual({
      reachable: false,
      reason: 'network_error',
      status: null,
    });
  });

  it('sends service token headers only to the validated public HTTPS endpoint', async () => {
    const request = vi.fn(async () => ({ status: 200, location: '' }));
    await probeTunnel('https://app.example.com', publicDns, request, {
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });
    expect(request).toHaveBeenCalledWith(
      new URL('https://app.example.com'),
      { address: '104.16.1.1', family: 4 },
      { 'CF-Access-Client-Id': 'client-id', 'CF-Access-Client-Secret': 'client-secret' },
    );
  });
});
