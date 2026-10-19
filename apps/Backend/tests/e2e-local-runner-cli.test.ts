import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { defaultBrowsersPath } from '../src/modules/e2e/adapters/playwright-runner.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import type { E2eAuthor } from '../src/modules/e2e/application/e2e-author.js';
import type { E2eRunner } from '../src/modules/e2e/application/e2e-runner.js';
import { HttpAdkClient } from '../../Mcp/src/api/http-client.js';
import { LocalRunnerAgent } from '../../Mcp/src/modules/e2e/local-runner/agent.js';
import { createLocalBrowser } from '../../Mcp/src/modules/e2e/local-runner/playwright-setup.js';
import { FakeScriptRepository } from './helpers/fake-script-repository.js';

const browsersPath =
  process.env['PLAYWRIGHT_BROWSERS_PATH'] || defaultBrowsersPath(process.platform, os.homedir());
const browserInstalled =
  existsSync(browsersPath) &&
  (await fs.readdir(browsersPath).catch(() => [])).some((name) => name.startsWith('chromium'));
const cliInstalled = existsSync(
  path.join(import.meta.dirname, '..', '..', 'Mcp', 'node_modules', '@playwright', 'test'),
);

const passing = `import { test, expect } from '@playwright/test';
test('TC001 - Open the home page', async ({ page }) => {
  await test.step('Open home', async () => {
    await page.goto('/');
    await expect(page).toHaveTitle('Local App');
  });
  await test.step('Read the greeting', async () => {
    await expect(page.getByRole('heading')).toHaveText('Hello from localhost');
  });
});`;
const failing = `import { test, expect } from '@playwright/test';
test('TC002 - Wrong title', async ({ page }) => {
  await test.step('Open home', async () => {
    await page.goto('/');
    await expect(page).toHaveTitle('Another App', { timeout: 1000 });
  });
});`;

/**
 * The whole local path with a real browser: the ADK API delegates to the CLI's runner,
 * which runs Chromium on this computer against a localhost app and reports back.
 */
describe.skipIf(!browserInstalled || !cliInstalled)('local runner CLI (real browser)', () => {
  let localApp: Server;
  let adk: Server;
  let appUrl: string;
  let adkUrl: string;
  const home = path.join(os.tmpdir(), `adk-runner-${process.pid}`);
  const app = createApp({
    e2eRunner: { explore: vi.fn(), run: vi.fn() } satisfies E2eRunner,
    e2eAuthor: {
      plan: vi.fn(),
      writeScript: vi.fn(),
      analyze: vi.fn().mockResolvedValue(null),
    } satisfies E2eAuthor,
    e2eArtifacts: new InMemoryE2eArtifactStore(),
    e2eScripts: new FakeScriptRepository(),
    requestContextResolver: () => ({
      requestId: 'cli-e2e',
      ownerId: 'ws',
      workspaceId: 'ws',
      actorId: 'qa-user',
      memberRole: 'ADMIN',
      locale: 'en-US',
    }),
  });

  beforeAll(async () => {
    localApp = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        '<!doctype html><title>Local App</title><h1>Hello from localhost</h1><button>Pay</button>',
      );
    });
    await new Promise<void>((resolve) => localApp.listen(0, '127.0.0.1', resolve));
    appUrl = `http://127.0.0.1:${(localApp.address() as AddressInfo).port}`;
    adk = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => adk.once('listening', resolve));
    adkUrl = `http://127.0.0.1:${(adk.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => localApp.close(resolve));
    await new Promise((resolve) => adk.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
  });

  it('explores and runs a localhost app on this computer and stores the evidence in ADK', async () => {
    const agentResponse = await request(app)
      .post('/agents')
      .send({ name: 'QA', instructions: 'Test things.' })
      .expect(201);
    const created = await request(app)
      .post('/e2e/creations')
      .send({
        name: 'Local app',
        agentId: agentResponse.body.agent.id,
        mode: 'frontend',
        baseUrl: appUrl,
        executionTarget: 'local',
        planning: 'host',
        prd: 'Home page',
        repository: { provider: 'github', id: '42', branch: 'main', path: 'tests/e2e' },
      })
      .expect(202);
    const id = created.body.creation.id as string;

    const events: string[] = [];
    const agent = new LocalRunnerAgent({
      api: new HttpAdkClient({ baseUrl: adkUrl, timeoutMs: 60_000, credentials: () => ({}) }),
      browser: await createLocalBrowser({ ADK_RUNNER_HOME: home }),
      identity: { id: 'runner-cli-e2e', name: 'CI', platform: process.platform, version: '0.0.0' },
      heartbeatMs: 1_000,
      onEvent: (event) => events.push(event.type),
    });

    // Host mode first captures the application, through the local runner.
    let explored = null;
    for (let attempt = 0; attempt < 10 && !explored; attempt++)
      explored = await agent.poll({ creationId: id, waitSeconds: 2 });
    expect(explored?.kind).toBe('explore');
    // The worker checks its task every second before storing the snapshot.
    let brief!: request.Response;
    await vi.waitFor(
      async () => {
        brief = await request(app).post(`/e2e/creations/${id}/brief`).send({}).expect(200);
        expect(brief.body.brief.snapshot).toMatchObject({ status: 'ready' });
      },
      { timeout: 10_000, interval: 250 },
    );
    expect(JSON.stringify(brief.body.brief.snapshot.data)).toContain('Hello from localhost');

    await request(app)
      .put(`/e2e/creations/${id}/plan`)
      .send({
        tests: [
          { title: 'Open the home page', script: passing },
          { title: 'Wrong title', script: failing },
        ],
      })
      .expect(202);
    const status = async () =>
      (await request(app).get(`/e2e/creations/${id}`).expect(200)).body.creation;
    await agent.serve({
      creationId: id,
      waitSeconds: 1,
      done: async () => (await status()).status === 'completed',
    });

    const [ok, broken] = (await status()).tests;
    expect(ok).toMatchObject({
      status: 'passed',
      executedOn: `CI (${process.platform})`,
      hasVideo: true,
      stepResults: [
        expect.objectContaining({ title: 'Open home', status: 'passed', hasScreenshot: true }),
        expect.objectContaining({ title: 'Read the greeting', status: 'passed' }),
      ],
    });
    expect(broken).toMatchObject({ status: 'failed', executedOn: `CI (${process.platform})` });
    expect(broken.error).toContain('Another App');
    const video = await request(app).get(`/e2e/tests/${ok.id}/video`).expect(200);
    expect(Buffer.from(video.body as Buffer).subarray(0, 4)).toEqual(
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    );
    expect(events).toEqual(['claimed', 'explored', 'claimed', 'finished', 'claimed', 'finished']);
  }, 120_000);
});
