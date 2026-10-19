import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption (AES-256-GCM) of small JSON payloads. Used for stateless OAuth client
 * ids, authorization requests and codes: they survive restarts and horizontal scaling, and their
 * content (including the ADK token inside a code) is unreadable and tamper-proof without the secret.
 */
export class Sealer {
  private readonly key: Buffer;

  public constructor(secret: string, purpose: string) {
    if (secret.length < 32) throw new Error('The OAuth secret must have at least 32 characters.');
    this.key = createHash('sha256').update(`${purpose}:${secret}`).digest();
  }

  public seal(payload: object, ttlMs?: number): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = JSON.stringify({ ...payload, ...(ttlMs ? { exp: Date.now() + ttlMs } : {}) });
    const encrypted = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  }

  /** Returns the payload, or undefined when the value is malformed, tampered with or expired. */
  public unseal<T extends object>(value: string): T | undefined {
    try {
      const raw = Buffer.from(value, 'base64url');
      if (raw.length < 29) return undefined;
      const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(
        'utf8',
      );
      const payload = JSON.parse(text) as T & { exp?: number };
      if (payload.exp !== undefined && payload.exp < Date.now()) return undefined;
      return payload;
    } catch {
      return undefined;
    }
  }
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
