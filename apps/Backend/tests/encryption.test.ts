import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decryptSecret, encryptSecret, resolveEncryptionKey } from '../src/shared/encryption.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('encryption module', () => {
  it('encrypts and decrypts with the key from INTEGRATION_ENCRYPTION_KEY', () => {
    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    const plaintext = randomBytes(16).toString('base64url');
    const encrypted = encryptSecret(plaintext);

    expect(encrypted).toContain(':');
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(3);

    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypts and decrypts with explicit key (buffer, 64-hex string, passphrase)', () => {
    const secret = 'custom-key-test';
    const hexKey = randomBytes(32).toString('hex');
    const bufferKey = randomBytes(32);
    const shortBufferKey = randomBytes(9);
    const passphraseKey = randomBytes(12).toString('base64url');

    expect(decryptSecret(encryptSecret(secret, hexKey), hexKey)).toBe(secret);
    expect(decryptSecret(encryptSecret(secret, bufferKey), bufferKey)).toBe(secret);
    expect(decryptSecret(encryptSecret(secret, shortBufferKey), shortBufferKey)).toBe(secret);
    expect(decryptSecret(encryptSecret(secret, passphraseKey), passphraseKey)).toBe(secret);
  });

  it('resolves key from environment variable when set', () => {
    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    expect(resolveEncryptionKey()).toHaveLength(32);

    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', randomBytes(8).toString('base64url'));
    expect(resolveEncryptionKey()).toHaveLength(32);
  });

  it('refuses to work without a configured key instead of using a built-in one', () => {
    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', '');
    expect(() => resolveEncryptionKey()).toThrow(
      expect.objectContaining({ code: 'ENCRYPTION_NOT_CONFIGURED', statusCode: 500 }),
    );
    expect(() => encryptSecret('anything')).toThrow('INTEGRATION_ENCRYPTION_KEY is not set');
  });

  it('rejects malformed encrypted payloads', () => {
    expect(() => decryptSecret('invalid')).toThrow('Invalid encrypted payload format');
    expect(() => decryptSecret('a:b')).toThrow('Invalid encrypted payload format');
    expect(() => decryptSecret('::')).toThrow('Invalid encrypted payload parts');
    expect(() => decryptSecret(':authTag:cipher')).toThrow('Invalid encrypted payload parts');
  });

  it('fails decryption on tampered ciphertext or auth tag', () => {
    const encrypted = encryptSecret('sensitive-data');
    const [iv, tag, cipher] = encrypted.split(':');
    if (!iv || !tag || !cipher) {
      throw new Error('Test setup failed');
    }

    // Tamper with ciphertext
    const tamperedCipher = `${cipher}ff`;
    expect(() => decryptSecret(`${iv}:${tag}:${tamperedCipher}`)).toThrow(
      'Failed to decrypt integration secret',
    );

    // Tamper with tag
    const tamperedTag = tag.startsWith('0') ? `f${tag.slice(1)}` : `0${tag.slice(1)}`;
    expect(() => decryptSecret(`${iv}:${tamperedTag}:${cipher}`)).toThrow(
      'Failed to decrypt integration secret',
    );
  });
});
