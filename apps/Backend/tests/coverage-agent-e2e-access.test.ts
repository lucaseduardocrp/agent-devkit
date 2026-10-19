import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accessHeaders,
  isLocalGatewayToken,
  isLoopbackRequest,
  localGatewayUrl,
} from '../src/modules/e2e/application/access-routing.js';
import {
  decryptAccessToken,
  encryptAccessToken,
} from '../src/modules/e2e/application/access-token.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('E2E access routing helpers', () => {
  it('routes a loopback request through the local gateway with its origin encoded', () => {
    const target = new URL('http://localhost:8014/api/items?page=2');
    const routed = localGatewayUrl(target, 'https://sample.trycloudflare.com/ignored');
    const encoded = Buffer.from('http://localhost:8014', 'utf8').toString('base64url');
    expect(routed).toBe(`https://sample.trycloudflare.com/_adk/local/${encoded}/api/items?page=2`);
    expect(
      Buffer.from(routed.split('/_adk/local/')[1]!.split('/')[0]!, 'base64url').toString('utf8'),
    ).toBe('http://localhost:8014');
  });

  it('recognises loopback HTTP(S) requests only', () => {
    expect(isLoopbackRequest(new URL('http://localhost:3000/'))).toBe(true);
    expect(isLoopbackRequest(new URL('https://127.0.0.1/'))).toBe(true);
    expect(isLoopbackRequest(new URL('http://[::1]:8080/'))).toBe(true);
    expect(isLoopbackRequest(new URL('http://LOCALHOST/'))).toBe(true);
    expect(isLoopbackRequest(new URL('ws://localhost:3000/'))).toBe(false);
    expect(isLoopbackRequest(new URL('https://app.example.com/'))).toBe(false);
    expect(isLoopbackRequest(new URL('http://127.0.0.2/'))).toBe(false);
  });

  it('tells local gateway tokens from Cloudflare service tokens', () => {
    expect(isLocalGatewayToken({ clientId: 'adk-local-123', clientSecret: 's' })).toBe(true);
    expect(isLocalGatewayToken({ clientId: 'abc.access', clientSecret: 's' })).toBe(false);
    expect(isLocalGatewayToken(null)).toBe(false);
    expect(isLocalGatewayToken(undefined)).toBe(false);
  });

  it('builds Access headers only when a token exists', () => {
    expect(accessHeaders({ clientId: 'id', clientSecret: 'secret' })).toEqual({
      'CF-Access-Client-Id': 'id',
      'CF-Access-Client-Secret': 'secret',
    });
    expect(accessHeaders(null)).toEqual({});
    expect(accessHeaders(undefined)).toEqual({});
  });
});

describe('E2E access token storage', () => {
  it('stores nothing when no field is filled', () => {
    expect(encryptAccessToken(undefined, undefined, 'http://localhost:3000')).toBeNull();
    expect(encryptAccessToken('', '', 'https://app.example.com')).toBeNull();
    expect(decryptAccessToken(null)).toBeNull();
    expect(decryptAccessToken(undefined)).toBeNull();
    expect(decryptAccessToken('')).toBeNull();
  });

  it('trims the fields and rejects blank ones', () => {
    const stored = encryptAccessToken(' id ', ' secret ', 'https://app.example.com');
    expect(decryptAccessToken(stored)).toEqual({ clientId: 'id', clientSecret: 'secret' });
    expect(() => encryptAccessToken('  ', 'secret', 'https://app.example.com')).toThrow(
      expect.objectContaining({ code: 'E2E_INVALID_ACCESS_TOKEN', statusCode: 400 }),
    );
    expect(() => encryptAccessToken(undefined, 'secret', 'https://app.example.com')).toThrow(
      expect.objectContaining({ code: 'E2E_INVALID_ACCESS_TOKEN' }),
    );
  });

  it('rejects header injection characters', () => {
    for (const [id, secret] of [
      ['id\r\nX-Evil: 1', 'secret'],
      ['id', 'sec\nret'],
      ['id', 'secret\0'],
    ])
      expect(() => encryptAccessToken(id, secret, 'https://app.example.com')).toThrow(
        expect.objectContaining({
          code: 'E2E_INVALID_ACCESS_TOKEN',
          message: 'The service token contains invalid characters.',
        }),
      );
  });

  it('refuses to store credentials without an encryption key', () => {
    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', '');
    expect(() => encryptAccessToken('id', 'secret', 'https://app.example.com')).toThrow(
      expect.objectContaining({ code: 'ENCRYPTION_NOT_CONFIGURED', statusCode: 500 }),
    );
  });
});
