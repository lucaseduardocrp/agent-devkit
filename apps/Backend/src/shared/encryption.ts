import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ApplicationError } from './errors.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // Standard 96-bit IV for GCM

export function resolveEncryptionKey(explicitKey?: string | Buffer): Buffer {
  if (explicitKey) {
    if (Buffer.isBuffer(explicitKey)) {
      return explicitKey.length === 32
        ? explicitKey
        : createHash('sha256').update(explicitKey).digest();
    }
    if (/^[0-9a-fA-F]{64}$/.test(explicitKey)) {
      return Buffer.from(explicitKey, 'hex');
    }
    return createHash('sha256').update(explicitKey).digest();
  }

  const envKey = process.env.INTEGRATION_ENCRYPTION_KEY?.trim();
  if (envKey) {
    if (/^[0-9a-fA-F]{64}$/.test(envKey)) {
      return Buffer.from(envKey, 'hex');
    }
    return createHash('sha256').update(envKey).digest();
  }

  // No built-in key: a key shipped in the source would decrypt every deployment's secrets.
  throw new ApplicationError(
    'ENCRYPTION_NOT_CONFIGURED',
    'INTEGRATION_ENCRYPTION_KEY is not set. Generate one with: openssl rand -hex 32',
    500,
  );
}

export function encryptSecret(plaintext: string, keyInput?: string | Buffer): string {
  const key = resolveEncryptionKey(keyInput);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptSecret(payload: string, keyInput?: string | Buffer): string {
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new ApplicationError('ENCRYPTION_ERROR', 'Invalid encrypted payload format.', 500);
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new ApplicationError('ENCRYPTION_ERROR', 'Invalid encrypted payload parts.', 500);
  }

  try {
    const key = resolveEncryptionKey(keyInput);
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const ciphertext = Buffer.from(ciphertextHex, 'hex');

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new ApplicationError('ENCRYPTION_ERROR', 'Failed to decrypt integration secret.', 500);
  }
}
