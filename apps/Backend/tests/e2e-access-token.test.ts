import { describe, expect, it } from 'vitest';
import {
  decryptAccessToken,
  encryptAccessToken,
} from '../src/modules/e2e/application/access-token.js';

describe('E2E Cloudflare Access token', () => {
  it('encrypts a complete service token and never stores its plaintext fields', () => {
    const encrypted = encryptAccessToken('client-id', 'client-secret', 'https://app.example.com');
    expect(encrypted).toBeTruthy();
    expect(encrypted).not.toContain('client-secret');
    expect(decryptAccessToken(encrypted)).toEqual({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });
  });

  it('rejects incomplete tokens and an insecure origin', () => {
    expect(() => encryptAccessToken('id', undefined, 'https://app.example.com')).toThrow();
    expect(() => encryptAccessToken('id', 'secret', 'http://app.example.com')).toThrow();
  });
});
