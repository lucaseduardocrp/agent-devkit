import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword } from '../src/modules/identity/domain/password.js';

describe('password hashing and verification', () => {
  it('hashes and verifies matching password', async () => {
    const password = 'mySecretPassword123!';
    const hash = await hashPassword(password);

    expect(hash).toContain(':');
    const [salt, key] = hash.split(':');
    expect(salt).toHaveLength(32);
    expect(key).toHaveLength(128);

    const valid = await verifyPassword(password, hash);
    expect(valid).toBe(true);
  });

  it('rejects incorrect password', async () => {
    const hash = await hashPassword('correctPassword');
    const valid = await verifyPassword('wrongPassword', hash);
    expect(valid).toBe(false);
  });

  it('handles malformed hash representations gracefully', async () => {
    expect(await verifyPassword('password', 'nohash')).toBe(false);
    expect(await verifyPassword('password', ':')).toBe(false);
    expect(await verifyPassword('password', 'salt:')).toBe(false);
    expect(await verifyPassword('password', ':key')).toBe(false);
    expect(await verifyPassword('password', 'salt:shortkey')).toBe(false);
    expect(await verifyPassword('password', 'salt:invalid-hex-zzzz')).toBe(false);
  });

  it('returns false when timingSafeEqual throws an unexpected error', async () => {
    const hash = await hashPassword('test');
    const spy = vi.spyOn(crypto, 'timingSafeEqual').mockImplementationOnce(() => {
      throw new Error('Comparison error');
    });

    const result = await verifyPassword('test', hash);
    expect(result).toBe(false);
    spy.mockRestore();
  });
});
