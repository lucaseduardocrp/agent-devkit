import { describe, expect, it } from 'vitest';
import { validateExternalUrl, WebhookReplayGuard } from '../src/modules/integrations/security.js';

describe('integration security', () => {
  it('accepts safe HTTP URLs', () => {
    expect(validateExternalUrl('https://example.com/wiki').hostname).toBe('example.com');
  });

  it('rejects invalid protocols and embedded credentials', () => {
    expect(() => validateExternalUrl('file:///tmp/data')).toThrow('protocol is not allowed');
    expect(() => validateExternalUrl('https://user:pass@example.com')).toThrow(
      'credentials are not allowed',
    );
    expect(() => validateExternalUrl('not a url')).toThrow('External URL is invalid');
  });

  it('rejects duplicate or empty webhook event ids', () => {
    const guard = new WebhookReplayGuard();
    expect(guard.accept('event-1')).toBe(true);
    expect(guard.accept('event-1')).toBe(false);
    expect(guard.accept('')).toBe(false);
  });
});
