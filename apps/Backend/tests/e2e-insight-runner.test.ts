import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PlaywrightE2eRunner,
  defaultBrowsersPath,
} from '../src/modules/e2e/adapters/playwright-runner.js';
import type {
  E2eAgentAction,
  E2eAgentObservation,
  E2eExploreEvent,
  E2eLiveFrame,
} from '../src/modules/e2e/application/e2e-runner.js';

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
  // The scripted agents below take their decisions in order: one browser explores.
  const single = new PlaywrightE2eRunner({
    workspaceRoot,
    timeoutMs: 120_000,
    settleMs: 150,
    explorers: 1,
  });

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
      'note:stopped_no_targets:2',
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

  it('lets an AI agent use the controls of the page like a person, never the ones that sign out', async () => {
    const views: E2eAgentObservation[] = [];
    const idOf = (view: E2eAgentObservation, label: string) =>
      view.elements.find((element) => element.label.includes(label))!.id;
    const decisions: ((view: E2eAgentObservation) => E2eAgentAction)[] = [
      (view) => ({ kind: 'click', element: idOf(view, 'Issues'), reason: 'open issues' }),
      (view) => ({
        kind: 'type',
        element: idOf(view, 'Search'),
        value: 'login bug',
        reason: 'filter the list',
      }),
      (view) => ({ kind: 'click', element: idOf(view, 'Sign out'), reason: 'leave' }),
      () => ({ kind: 'finish', reason: 'covered' }),
    ];
    const events: E2eExploreEvent[] = [];
    const snapshot = await single.explore({
      mode: 'frontend',
      url: `${baseUrl}/`,
      credentials: { username: 'qa@example.com', password: 's3cret-pass' },
      onProgress: (event) => events.push(event),
      agent: (view) => {
        views.push(view);
        return Promise.resolve(decisions[views.length - 1]!(view));
      },
    });

    const log = events.filter((event) => event.kind === 'log');
    expect(log.map((entry) => [entry.action, entry.target, entry.reason])).toEqual([
      ['navigate', `${baseUrl}/`, undefined],
      ['sign_in', 'qa@example.com', undefined],
      ['click', 'Issues', 'open issues'],
      ['type', 'Search = login bug', 'filter the list'],
      ['note', 'agent_done:2', 'covered'],
    ]);
    expect(snapshot.pages.map((item) => item.headings[0])).toEqual([
      'Sign in',
      'Dashboard',
      'Issues',
    ]);
    // The agent reads numbered controls with their names, without the ones that are hidden.
    expect(views[0]!.elements.map((element) => element.label)).toEqual(
      expect.arrayContaining(['Issues', 'Inbox', 'Sign out', 'Search', 'State', 'Only mine']),
    );
    expect(views[0]!.elements.some((element) => element.label === 'Enter')).toBe(false);
    expect(views[0]!.elements.some((element) => element.label === 'Disabled')).toBe(false);
    // What it typed reaches the page, and the next screen shows it.
    expect(views[2]!.text).toContain('login bug');
    expect(views[2]!.history).toEqual([
      '1. click "Issues" -> Issues',
      '2. type "Search = login bug" -> Issues',
    ]);
    // Signing out was refused: the session is still open for the last step.
    expect(views[3]!.history.at(-1)).toContain('not done');
    expect(views[3]!.elements.some((element) => element.label === 'Sign out')).toBe(true);
  }, 120_000);

  it('explores with several browsers at once, each signed in and covering its own areas', async () => {
    const views: E2eAgentObservation[] = [];
    const clicked = new Set<number>();
    const events: E2eExploreEvent[] = [];
    const snapshot = await new PlaywrightE2eRunner({
      workspaceRoot,
      timeoutMs: 120_000,
      settleMs: 150,
      explorers: 2,
    }).explore({
      mode: 'frontend',
      url: `${baseUrl}/`,
      credentials: { username: 'qa@example.com', password: 's3cret-pass' },
      onProgress: (event) => events.push(event),
      agent: (view) => {
        views.push(view);
        const { worker, areas } = view.assignment!;
        if (clicked.has(worker)) return Promise.resolve({ kind: 'finish', reason: 'done' });
        clicked.add(worker);
        const element = view.elements.find((item) => item.label === areas[0])!;
        return Promise.resolve({ kind: 'click', element: element.id, reason: 'my area' });
      },
    });

    // The navigation was dealt between two browsers.
    const shares = new Map(views.map((view) => [view.assignment!.worker, view.assignment!.areas]));
    expect([...shares.entries()].sort()).toEqual([
      [1, ['Issues']],
      [2, ['Inbox']],
    ]);
    expect(views.every((view) => view.assignment!.workers === 2)).toBe(true);
    // Both were signed in (the second one on its own), and the screens of both are in the snapshot.
    expect(views.filter((view) => view.step === 1).map((view) => view.page.headings[0])).toEqual([
      'Dashboard',
      'Dashboard',
    ]);
    expect(snapshot.pages.map((item) => item.headings[0]).sort()).toEqual([
      'Dashboard',
      'Inbox',
      'Issues',
      'Sign in',
    ]);
    // One sign-in and one closing note in the log, and the phase never goes back.
    const log = events.filter((event) => event.kind === 'log');
    expect(log.filter((entry) => entry.action === 'sign_in')).toHaveLength(1);
    expect(log.filter((entry) => entry.action === 'note')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'phase').map((event) => event.phase)).toEqual([
      'signing_in',
      'exploring',
    ]);
  }, 120_000);

  it('chooses in a drop-down list and scrolls, like a person filling a form', async () => {
    const views: E2eAgentObservation[] = [];
    const idOf = (view: E2eAgentObservation, label: string) =>
      view.elements.find((element) => element.label.includes(label))!.id;
    const decisions: ((view: E2eAgentObservation) => E2eAgentAction)[] = [
      (view) => ({ kind: 'select', element: idOf(view, 'State'), option: 'done', reason: 'pick' }),
      () => ({ kind: 'scroll', direction: 'down', reason: 'look below' }),
      (view) => ({ kind: 'click', element: idOf(view, 'Only mine'), reason: 'tick' }),
      (view) => ({ kind: 'select', element: idOf(view, 'State'), option: 'Archived', reason: 'x' }),
      () => ({ kind: 'finish', reason: 'covered' }),
    ];
    const events: E2eExploreEvent[] = [];
    await single.explore({
      mode: 'frontend',
      url: `${baseUrl}/`,
      credentials: { username: 'qa@example.com', password: 's3cret-pass' },
      onProgress: (event) => events.push(event),
      agent: (view) => {
        views.push(view);
        return Promise.resolve(decisions[views.length - 1]!(view));
      },
    });
    const log = events.filter((event) => event.kind === 'log');
    expect(log.map((entry) => [entry.action, entry.target])).toEqual([
      ['navigate', `${baseUrl}/`],
      ['sign_in', 'qa@example.com'],
      // The choice is found by its text, whatever the case, and the control reports what it holds.
      ['select', 'State = Done'],
      ['scroll', 'down'],
      ['click', 'Only mine'],
      ['note', 'agent_done:3'],
    ]);
    const state = (view: E2eAgentObservation) =>
      view.elements.find((element) => element.label === 'State')!;
    expect(state(views[0]!).options).toEqual(['Open', 'Done']);
    expect(state(views[1]!).value).toBe('Done');
    expect(views[2]!.elements.find((element) => element.label === 'Only mine')!.checked).toBe(
      false,
    );
    expect(views[3]!.elements.find((element) => element.label === 'Only mine')!.checked).toBe(true);
    // A choice the list does not have is refused, and the agent is told.
    expect(views[4]!.history.at(-1)).toContain('State has no choice "Archived"');
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
