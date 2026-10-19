import { afterEach, describe, expect, it, vi } from 'vitest';
import { localTunnelBridge } from '../src/features/e2e/local-tunnel-bridge.js';

afterEach(() => vi.unstubAllGlobals());

describe('local tunnel bridge client', () => {
  it('starts and stops a local tunnel through the loopback helper', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tunnel: {
          localUrl: 'http://localhost:5173',
          publicUrl: 'https://sample.trycloudflare.com',
        },
      }),
    });
    vi.stubGlobal('fetch', fetcher);
    await expect(localTunnelBridge.start('http://localhost:5173')).resolves.toMatchObject({
      tunnel: { publicUrl: 'https://sample.trycloudflare.com' },
    });
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/tunnel',
      expect.objectContaining({
        method: 'POST',
        body: '{"url":"http://localhost:5173"}',
      }),
    );
    await localTunnelBridge.status();
    await localTunnelBridge.stop();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('shows the helper error without exposing a raw network response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'Bad local URL.' }) }),
    );
    await expect(localTunnelBridge.start('http://example.com')).rejects.toThrow('Bad local URL.');
  });

  it('classifies an unreachable helper and a helper started for another origin', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(localTunnelBridge.status()).rejects.toMatchObject({ code: 'unreachable' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ code: 'origin_mismatch', error: 'Another origin.' }),
      }),
    );
    await expect(localTunnelBridge.status()).rejects.toMatchObject({ code: 'origin_mismatch' });
  });
});
