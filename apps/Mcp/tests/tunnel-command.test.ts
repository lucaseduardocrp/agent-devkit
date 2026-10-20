import { describe, expect, it } from 'vitest';
import { localOrigin, quickTunnelCommand } from '../src/modules/e2e/tunnel-command.js';

describe('tunnel commands', () => {
  it('accepts only loopback HTTP origins', () => {
    expect(localOrigin('http://localhost:5173/login')).toBe('http://localhost:5173');
    expect(localOrigin('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(() => localOrigin('https://example.com')).toThrow('loopback');
    expect(() => localOrigin('http://user:pass@localhost:5173')).toThrow('loopback');
    expect(() => localOrigin('not a url')).toThrow('Enter a local URL');
  });

  it('uses the local Host header for the public tunnel', () => {
    expect(quickTunnelCommand('http://localhost:5173/login')).toBe(
      'cloudflared tunnel --url http://localhost:5173 --http-host-header localhost:5173',
    );
  });
});
