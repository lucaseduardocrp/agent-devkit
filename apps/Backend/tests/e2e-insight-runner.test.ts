import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PlaywrightE2eRunner,
  defaultBrowsersPath,
} from '../src/modules/e2e/adapters/playwright-runner.js';
import type { E2eExploreEvent, E2eLiveFrame } from '../src/modules/e2e/application/e2e-runner.js';

const browsersPath = process.env['PLAYWRIGHT_BROWSERS_PATH'] || defaultBrowsersPath();
const browserInstalled =
  fs.existsSync(browsersPath) &&
  fs.readdirSync(browsersPath).some((entry) => entry.startsWith('chromium'));

/** A single-page app: a sign-in form, then screens that change without changing the address. */
const app = `<!doctype html><html><head><title>Mini app</title></head><body>
<h1 style="position:absolute;width:1px;height:1px;overflow:hidden">Application</h1>
<form id="login" onsubmit="event.preventDefault(); if (user.value === 'qa@example.com' && pass.value === 's3cret-pass') { login.hidden = true; shell.hidden = false; }">
  <h2>Sign in</h2>
  <label for="user">Email</label><input id="user" type="email" />
  <label for="pass">Password</label><input id="pass" type="password" />
  <button type="submit">Enter</button>
</form>
<div id="shell" hidden>
  <nav>
    <button onclick="show('Issues')">Issues</button>
    <button onclick="show('Inbox')">Inbox</button>
    <button onclick="document.title = 'signed-out'; shell.hidden = true; login.hidden = false">Sign out</button>
    <a href="https://example.invalid/docs">External docs</a>
    <button disabled>Disabled</button>
  </nav>
  <h2 id="screen">Dashboard</h2>
  <label for="search">Search</label><input id="search" placeholder="Search issues" />
  <label><input type="checkbox" id="mine" /> Only mine</label>
  <select id="state" aria-label="State"><option>Open</option><option>Done</option></select>
  <p id="echo"></p>
</div>
<script>
  function show(name) { document.getElementById('screen').textContent = name; }
  document.getElementById('search').addEventListener('input', (event) => {
    document.getElementById('echo').textContent = event.target.value;
  });
</script>
</body></html>`;

describe.skipIf(!browserInstalled)('exploration and action trail (real browser)', () => {
  let server: http.Server;
  let baseUrl: string;
  const workspaceRoot = fs.mkdtempSync(path.join(process.cwd(), '.e2e-workspaces-test-'));
  const runner = new PlaywrightE2eRunner({ workspaceRoot, timeoutMs: 120_000, settleMs: 150 });

  beforeAll(async () => {
    server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(app);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('signs in with the test account and clicks through the navigation of an SPA', async () => {
    const events: E2eExploreEvent[] = [];
    const snapshot = await runner.explore({
      mode: 'frontend',
      url: `${baseUrl}/`,
      credentials: { username: 'qa@example.com', password: 's3cret-pass' },
      onProgress: (event) => events.push(event),
    });

    // The sign-in screen and each screen behind the navigation, although the address never changes.
    // Headings that are hidden or only for screen readers do not name a screen.
    expect(snapshot.pages.map((item) => item.headings)).toEqual([
      ['Sign in'],
      ['Dashboard'],
      ['Issues'],
      ['Inbox'],
    ]);
    expect(events.filter((event) => event.kind === 'phase').map((event) => event.phase)).toEqual([
      'signing_in',
      'exploring',
    ]);
    const log = events.filter((event) => event.kind === 'log');
    expect(log.map((entry) => `${entry.action}:${entry.target}`)).toEqual([
      `navigate:${baseUrl}/`,
      'sign_in:qa@example.com',
      'click:Issues',
      'click:Inbox',
    ]);
    // Signing out, leaving the site and disabled controls are never clicked.
    expect(snapshot.pages.some((item) => item.title === 'signed-out')).toBe(false);
    const captured = events.filter((event) => event.kind === 'page');
    expect(captured).toHaveLength(4);
    for (const item of captured)
      expect(Buffer.from(item.screenshot!).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(events.filter((event) => event.kind === 'frame').length).toBeGreaterThanOrEqual(4);
    // The password is typed into the browser only; it never reaches the log.
    expect(JSON.stringify(log)).not.toContain('s3cret-pass');
  }, 120_000);

  it('records the screens, elements and actions of a UI test and follows it live', async () => {
    const frames: E2eLiveFrame[] = [];
    const result = await runner.run({
      mode: 'frontend',
      baseUrl,
      locale: 'en-US',
      credentials: { username: 'qa@example.com', password: 's3cret-pass' },
      variables: { PLAN: 'premium-plan', 'not valid': 'ignored' },
      onLive: (frame) => frames.push(frame),
      script: `import { test, expect } from '@playwright/test';
test('TC001 - search issues', async ({ page }) => {
  await test.step('Step 1 - sign in', async () => {
    await page.goto('/');
    await page.getByLabel('Email').fill(process.env.E2E_USERNAME!);
    await page.getByLabel('Password').fill(process.env.E2E_PASSWORD!);
    await page.getByRole('button', { name: 'Enter' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
  await test.step('Step 2 - open issues and search', async () => {
    await page.getByRole('button', { name: 'Issues' }).click();
    await page.getByLabel('Search').pressSequentially(process.env.E2E_VAR_PLAN!);
    await page.getByLabel('Only mine').check();
    await page.getByLabel('State').selectOption('Done');
    await expect(page.locator('#echo')).toHaveText('premium-plan');
  });
});`,
    });

    expect(result.error).toBeNull();
    expect(result.status).toBe('passed');
    const trail = result.trail!;
    expect(trail.pages.map((item) => item.title)).toEqual(['Sign in', 'Dashboard', 'Issues']);
    expect(trail.visits).toEqual([1, 2, 3]);
    for (const item of trail.pages)
      expect(Buffer.from(item.screenshot!).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(trail.elements.map((item) => `${item.kind}:${item.name}`)).toEqual([
      'field:Email',
      'field:Password',
      'button:Enter',
      'button:Issues',
      'field:Search',
      'checkbox:Only mine',
      'select:State',
    ]);
    const email = trail.elements[0]!;
    expect(email.pageIndex).toBe(1);
    expect(email.box!.width).toBeGreaterThan(0);
    expect(email.box!.x + email.box!.width).toBeLessThanOrEqual(1);
    expect(email.screenshot).not.toBeNull();
    expect(
      trail.touches.map((touch) => [touch.step, touch.action, touch.elementIndex, touch.value]),
    ).toEqual([
      // The account is redacted like everywhere else in the run's output.
      [1, 'type', 1, '[redacted]'],
      [1, 'type', 2, '******'],
      [1, 'click', 3, null],
      [2, 'click', 4, null],
      // Typed key by key through another locator action, and still one touch. The variable's
      // value is a secret of the run, so it is masked like the password.
      [2, 'type', 5, '[redacted]'],
      [2, 'check', 6, null],
      [2, 'select', 7, 'Done'],
    ]);
    // The spec read the variable (the echo assertion passed) and the log does not show it.
    expect(result.logs).not.toContain('premium-plan');

    expect(frames.length).toBeGreaterThan(0);
    expect(Buffer.from(frames[0]!.image).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    const last = frames.at(-1)!.activity!;
    expect(last.step).toBe(2);
    expect(['click', 'type', 'check', 'select']).toContain(last.action);
  }, 180_000);

  it('leaves API tests without a trail', async () => {
    const result = await runner.run({
      mode: 'backend',
      baseUrl,
      locale: 'en-US',
      credentials: { username: null, password: null },
      onLive: () => {
        throw new Error('API tests have no browser to show');
      },
      script: `import { test, expect } from '@playwright/test';
test('TC001 - responds', async ({ request }) => {
  expect((await request.get('/')).status()).toBe(200);
});`,
    });
    expect(result.status).toBe('passed');
    expect(result.trail).toBeNull();
  }, 120_000);
});
