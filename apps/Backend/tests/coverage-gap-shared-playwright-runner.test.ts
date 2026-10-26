import { describe, expect, it, vi } from 'vitest';
import {
  PlaywrightE2eRunner,
  type PlaywrightModule,
} from '../src/modules/e2e/adapters/playwright-runner.js';

describe('Playwright runner with host access', () => {
  it('launches Chromium with the host rules and refuses Access headers it cannot scope', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const newPage = vi.fn().mockResolvedValue({});
    const launch = vi.fn().mockResolvedValue({ newPage, close });
    const runner = new PlaywrightE2eRunner({
      hostAlias: 'host.docker.internal',
      loadPlaywright: () =>
        Promise.resolve({ chromium: { launch } } as unknown as PlaywrightModule),
    });
    await expect(
      runner.explore({
        mode: 'frontend',
        url: 'http://localhost:5173',
        accessToken: { clientId: 'id', clientSecret: 'secret' },
      }),
    ).rejects.toThrow('does not support scoped Access headers');
    expect(launch).toHaveBeenCalledWith({
      headless: true,
      args: [
        '--host-resolver-rules=MAP localhost host.docker.internal, MAP 127.0.0.1 host.docker.internal',
      ],
    });
    expect(newPage).toHaveBeenCalledWith({ ignoreHTTPSErrors: true });
    expect(close).toHaveBeenCalled();
  });
});
