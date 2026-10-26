import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  PlaywrightE2eRunner,
  readStepEvidence,
  type PlaywrightModule,
} from '../src/modules/e2e/adapters/playwright-runner.js';

const LOCAL = 'http://localhost:5173';
const TRANSPORT = 'https://sample.trycloudflare.com';
const gatewayToken = { clientId: 'adk-local-abc', clientSecret: 'gateway-secret' };

const snapshot = (url: string) => ({
  url,
  title: 'Home',
  headings: [],
  buttons: [],
  links: [],
  fields: [],
  testIds: [],
});

/** A request the page makes while loading; the runner decides how it reaches the app. */
function fakeRoute(url: string, responseHeaders: Record<string, string> = {}) {
  const response = { headers: () => ({ ...responseHeaders }) };
  return {
    request: () => ({ url: () => url, headers: () => ({ accept: '*/*' }) }),
    continue: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockResolvedValue(response),
    fulfill: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    response,
  };
}
type FakeRoute = ReturnType<typeof fakeRoute>;

function browserWith(routes: FakeRoute[], options: { waitForURL?: boolean } = {}) {
  let handler: ((route: FakeRoute) => Promise<void>) | undefined;
  const page = {
    route: vi.fn(async (_pattern: string, next: (route: FakeRoute) => Promise<void>) => {
      handler = next;
    }),
    goto: vi.fn(async () => {
      for (const route of routes) await handler!(route);
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    ...(options.waitForURL === false
      ? {}
      : { waitForURL: vi.fn().mockRejectedValue(new Error('no redirect')) }),
    evaluate: vi.fn().mockResolvedValue(snapshot(`${LOCAL}/`)),
  };
  const newPage = vi.fn().mockResolvedValue(page);
  const close = vi.fn().mockResolvedValue(undefined);
  const runner = new PlaywrightE2eRunner({
    loadPlaywright: () =>
      Promise.resolve({
        chromium: { launch: () => Promise.resolve({ newPage, close }) },
      } as unknown as PlaywrightModule),
  });
  return { runner, page, newPage, close };
}

describe('PlaywrightE2eRunner exploring through a public transport (fake browser)', () => {
  it('loads the localhost origin through the tunnel and maps redirects back to it', async () => {
    const sameOrigin = fakeRoute(`${LOCAL}/app?tab=1`, {
      location: `${TRANSPORT}/login?next=%2Fapp#top`,
    });
    const localApi = fakeRoute('http://127.0.0.1:8080/api/items?page=2', {
      location: 'https://sso.example.com/authorize',
    });
    const plain = fakeRoute(`${LOCAL}/favicon.ico`);
    const transportAsset = fakeRoute(`${TRANSPORT}/asset.js`);
    const external = fakeRoute('https://cdn.example.com/lib.js');
    const { runner, page, newPage, close } = browserWith([
      sameOrigin,
      localApi,
      plain,
      transportAsset,
      external,
    ]);

    const result = await runner.explore({
      mode: 'frontend',
      url: `${LOCAL}/`,
      transportUrl: TRANSPORT,
      accessToken: gatewayToken,
    });

    expect(result).toEqual({ startUrl: `${LOCAL}/`, pages: [snapshot(`${LOCAL}/`)] });
    expect(newPage).toHaveBeenCalledWith({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    expect(page.route).toHaveBeenCalledWith('**/*', expect.any(Function));
    const accessHeaders = {
      accept: '*/*',
      'CF-Access-Client-Id': 'adk-local-abc',
      'CF-Access-Client-Secret': 'gateway-secret',
    };

    // Same origin: fetched from the tunnel, and a redirect to the tunnel points back to localhost.
    expect(sameOrigin.fetch).toHaveBeenCalledWith({
      url: `${TRANSPORT}/app?tab=1`,
      headers: accessHeaders,
      maxRedirects: 0,
      timeout: 20_000,
    });
    expect(sameOrigin.fulfill).toHaveBeenCalledWith({
      response: sameOrigin.response,
      headers: { location: `${LOCAL}/login?next=%2Fapp#top` },
    });

    // Another local service: sent through the local gateway; foreign redirects stay untouched.
    const encoded = Buffer.from('http://127.0.0.1:8080', 'utf8').toString('base64url');
    expect(localApi.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ url: `${TRANSPORT}/_adk/local/${encoded}/api/items?page=2` }),
    );
    expect(localApi.fulfill).toHaveBeenCalledWith({
      response: localApi.response,
      headers: { location: 'https://sso.example.com/authorize' },
    });
    expect(plain.fulfill).toHaveBeenCalledWith({ response: plain.response, headers: {} });

    // The tunnel itself receives the token; other origins never do.
    expect(transportAsset.continue).toHaveBeenCalledWith({ headers: accessHeaders });
    expect(external.continue).toHaveBeenCalledWith(undefined);
    expect(external.fetch).not.toHaveBeenCalled();

    // A tunnel run waits for the first page's client-side redirect, ignoring a timeout.
    expect(page.waitForURL).toHaveBeenCalledWith(expect.any(Function), { timeout: 6_000 });
    const settled = (page.waitForURL as ReturnType<typeof vi.fn>).mock.calls[0]![0] as (
      url: URL,
    ) => boolean;
    expect(settled(new URL(`${LOCAL}/`))).toBe(false);
    expect(settled(new URL(`${LOCAL}/home`))).toBe(true);
    expect(page.waitForLoadState).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalled();
  });

  it('keeps other loopback services direct when the token is not the local gateway', async () => {
    const loopback = fakeRoute('http://127.0.0.1:8080/api');
    const transportAsset = fakeRoute(`${TRANSPORT}/asset.js`);
    const { runner } = browserWith([loopback, transportAsset]);
    await runner.explore({
      mode: 'frontend',
      url: `${LOCAL}/`,
      transportUrl: TRANSPORT,
      accessToken: { clientId: 'cf.access', clientSecret: 'cf-secret' },
    });
    expect(loopback.fetch).not.toHaveBeenCalled();
    expect(loopback.continue).toHaveBeenCalledWith(undefined);
    expect(transportAsset.continue).toHaveBeenCalledWith({
      headers: {
        accept: '*/*',
        'CF-Access-Client-Id': 'cf.access',
        'CF-Access-Client-Secret': 'cf-secret',
      },
    });
  });

  it('routes a tunnel without a token and skips redirect settling without waitForURL', async () => {
    const sameOrigin = fakeRoute(`${LOCAL}/`);
    const transportAsset = fakeRoute(`${TRANSPORT}/asset.js`);
    const { runner, page } = browserWith([sameOrigin, transportAsset], { waitForURL: false });
    await runner.explore({ mode: 'frontend', url: `${LOCAL}/`, transportUrl: TRANSPORT });
    expect(sameOrigin.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ url: `${TRANSPORT}/`, headers: { accept: '*/*' } }),
    );
    expect(transportAsset.continue).toHaveBeenCalledWith(undefined);
    expect(page.waitForLoadState).toHaveBeenCalledTimes(1);
  });
});

describe('readStepEvidence', () => {
  const directories: string[] = [];
  afterAll(async () => {
    for (const directory of directories) await fs.rm(directory, { recursive: true, force: true });
  });

  it('returns no steps when nothing was recorded', async () => {
    await expect(
      readStepEvidence(path.join(os.tmpdir(), 'adk-missing-evidence-dir'), []),
    ).resolves.toEqual([]);
  });

  it('keeps valid lines, redacts secrets and only attaches safe, small screenshots', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-steps-'));
    directories.push(directory);
    const small = Buffer.from('png-bytes');
    await fs.writeFile(path.join(directory, 'step-01.png'), small);
    await fs.writeFile(path.join(directory, 'step-02.png'), Buffer.alloc(5_000_001));
    await fs.writeFile(path.join(directory, 'evil.png'), small);
    const lines = [
      '{not json',
      JSON.stringify({ position: '1', title: 'Wrong position type' }),
      JSON.stringify({ position: 1 }),
      JSON.stringify({
        position: 1,
        title: 'Sign in as qa@example.com',
        status: 'passed',
        durationMs: 120,
        screenshot: 'step-01.png',
      }),
      JSON.stringify({
        position: 2,
        title: 'Submit',
        status: 'failed',
        error: '\u001b[31mExpected secret-pass\u001b[39m',
        screenshot: 'step-02.png',
      }),
      JSON.stringify({ position: 3, title: 'Missing file', screenshot: 'step-03.png' }),
      JSON.stringify({ position: 4, title: 'Unsafe name', screenshot: '../evil.png' }),
      JSON.stringify({ position: 5, title: 'Not a name', screenshot: 5, durationMs: '9' }),
      '',
    ];
    await fs.writeFile(path.join(directory, 'steps.jsonl'), lines.join('\n'), 'utf8');

    const steps = await readStepEvidence(directory, ['qa@example.com', 'secret-pass', null]);

    expect(steps).toHaveLength(5);
    expect(steps[0]).toEqual({
      position: 1,
      title: 'Sign in as [redacted]',
      status: 'passed',
      durationMs: 120,
      error: null,
      screenshot: expect.any(Buffer),
    });
    expect(Buffer.from(steps[0]!.screenshot!).toString()).toBe('png-bytes');
    expect(steps[1]).toMatchObject({
      position: 2,
      status: 'failed',
      durationMs: 0,
      error: 'Expected [redacted]',
      screenshot: null,
    });
    expect(steps.slice(2).map((step) => [step.position, step.status, step.screenshot])).toEqual([
      [3, 'failed', null],
      [4, 'failed', null],
      [5, 'failed', null],
    ]);
  });
});

describe('PlaywrightE2eRunner tolerating slow pages and cleanup failures', () => {
  it('explores even when the page never reaches network idle', async () => {
    const { runner, page } = browserWith([]);
    page.waitForLoadState.mockRejectedValue(new Error('networkidle timeout'));
    const result = await runner.explore({
      mode: 'frontend',
      url: `${LOCAL}/`,
      transportUrl: TRANSPORT,
      accessToken: gatewayToken,
    });
    expect(result.pages).toHaveLength(1);
    expect(page.waitForLoadState).toHaveBeenCalledTimes(2);
  });

  it('returns the run result when its workspace cannot be removed', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-pw-cleanup-'));
    const rm = vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('EBUSY'));
    try {
      const runner = new PlaywrightE2eRunner({
        workspaceRoot,
        executor: async () => ({ stdout: 'done', stderr: '', exitCode: 1, timedOut: false }),
      });
      const result = await runner.run({
        mode: 'backend',
        baseUrl: 'http://api.example.test',
        locale: 'en-US',
        credentials: { username: null, password: null },
        script: "import { test } from '@playwright/test';\ntest('x', async () => {});",
      });
      expect(result.status).toBe('failed');
      expect(rm).toHaveBeenCalled();
    } finally {
      rm.mockRestore();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
