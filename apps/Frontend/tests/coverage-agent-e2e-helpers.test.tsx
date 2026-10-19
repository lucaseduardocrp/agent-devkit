import { afterEach, describe, expect, it, vi } from 'vitest';
import { isQuickTunnelUrl, needsPolling } from '../src/features/e2e/e2e-types.js';
import { LocalHelperError, localTunnelBridge } from '../src/features/e2e/local-tunnel-bridge.js';

afterEach(() => vi.unstubAllGlobals());

describe('E2E type helpers', () => {
  it('recognizes quick tunnel URLs and rejects invalid addresses', () => {
    expect(isQuickTunnelUrl(' https://sample.trycloudflare.com/app ')).toBe(true);
    expect(isQuickTunnelUrl('https://app.example.com')).toBe(false);
    expect(isQuickTunnelUrl('not a url')).toBe(false);
  });

  it('polls active runs and publications in progress only', () => {
    expect(needsPolling({ status: 'running', lastReport: null })).toBe(true);
    expect(needsPolling({ status: 'completed', lastReport: null })).toBe(false);
    const report = {
      provider: 'testrail' as const,
      remoteRunId: null,
      url: null,
      publishedCases: 0,
      warnings: [],
      error: null,
      updatedAt: '2026-10-07T10:02:00Z',
    };
    expect(
      needsPolling({ status: 'completed', lastReport: { ...report, status: 'publishing' } }),
    ).toBe(true);
    expect(
      needsPolling({ status: 'completed', lastReport: { ...report, status: 'published' } }),
    ).toBe(false);
  });
});

describe('local tunnel bridge failures', () => {
  it('reports a generic failure when the helper answers without a readable body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
      }),
    );
    const failure = localTunnelBridge.stop();
    await expect(failure).rejects.toBeInstanceOf(LocalHelperError);
    await expect(failure).rejects.toMatchObject({
      code: 'failed',
      message: 'Local tunnel helper is unavailable.',
      name: 'LocalHelperError',
    });
  });
});
