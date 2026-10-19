import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PlaywrightE2eRunner,
  defaultBrowsersPath,
  FINAL_HOLD_MS,
  runProcess,
} from '../src/modules/e2e/adapters/playwright-runner.js';
import {
  FfmpegVideoTranscoder,
  resolveFfmpegPath,
} from '../src/modules/e2e/adapters/ffmpeg-transcoder.js';
import { createLocalGateway } from '../../Mcp/src/modules/e2e/cloudflare-tunnel.js';

const browsersPath = process.env['PLAYWRIGHT_BROWSERS_PATH'] || defaultBrowsersPath();
const browserInstalled =
  fs.existsSync(browsersPath) &&
  fs.readdirSync(browsersPath).some((entry) => entry.startsWith('chromium'));

const page = `<!doctype html><html><head><title>Evento de teste</title></head><body>
<h1>Evento de teste</h1>
<label for="question">Qual a sua pergunta?</label>
<textarea id="question" name="question" placeholder="Qual a sua pergunta?"></textarea>
<button data-testid="send" onclick="document.getElementById('list').insertAdjacentHTML('beforeend', '<li>' + document.getElementById('question').value + '</li>')">Enviar pergunta</button>
<ul id="list"></ul>
<a href="/about">Sobre</a>
</body></html>`;

describe.skipIf(!browserInstalled)('Playwright E2E runner (real browser)', () => {
  let server: http.Server;
  let externalServer: http.Server;
  let apiServer: http.Server;
  let baseUrl: string;
  let externalUrl: string;
  let apiUrl: string;
  const externalHeaders: string[] = [];
  const workspaceRoot = fs.mkdtempSync(path.join(process.cwd(), '.e2e-workspaces-test-'));
  const runner = new PlaywrightE2eRunner({ workspaceRoot, timeoutMs: 120_000 });

  beforeAll(async () => {
    externalServer = http.createServer((request, response) => {
      if (request.url === '/discovery') {
        response
          .writeHead(200, {
            'content-type': 'application/json',
            'access-control-allow-origin': 'http://localhost:43123',
          })
          .end('{"issuer":"mock-sso"}');
        return;
      }
      if (request.url === '/login-redirect') {
        response.writeHead(302, {
          location: '/second-redirect',
          'set-cookie': 'session=ok; Path=/; HttpOnly',
        });
        response.end();
        return;
      }
      if (request.url === '/second-redirect') {
        if (!String(request.headers.cookie ?? '').includes('session=ok')) {
          response.writeHead(403).end('Missing session');
          return;
        }
        response.writeHead(302, { location: 'http://localhost:43123/after-login' });
        response.end();
        return;
      }
      externalHeaders.push(String(request.headers['cf-access-client-secret'] ?? ''));
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end();
    });
    await new Promise<void>((resolve) => externalServer.listen(0, '127.0.0.1', resolve));
    externalUrl = `http://127.0.0.1:${(externalServer.address() as AddressInfo).port}`;
    apiServer = http.createServer((request, response) => {
      if (request.url === '/api/status') {
        if (request.method === 'OPTIONS') {
          response
            .writeHead(204, {
              'access-control-allow-origin': 'http://localhost:43123',
              'access-control-allow-methods': 'POST, OPTIONS',
              'access-control-allow-headers': 'content-type',
            })
            .end();
          return;
        }
        response
          .writeHead(200, {
            'content-type': 'application/json',
            'access-control-allow-origin': 'http://localhost:43123',
            vary: 'Origin',
          })
          .end('{"status":"api ready"}');
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
    apiUrl = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
    server = http.createServer((request, response) => {
      if (request.url === '/fullstack') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(`<script>
          Promise.all([
            fetch('${apiUrl}/api/status', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
            }).then(r => r.json()),
            fetch('${externalUrl}/discovery').then(r => r.json()),
          ]).then(([api, sso]) => {
            document.body.innerHTML = '<h1>' + api.status + ' / ' + sso.issuer + '</h1>';
          }).catch(error => document.body.innerHTML = '<h1>' + error.message + '</h1>');
        </script>`);
        return;
      }
      if (request.url?.startsWith('/broken?')) {
        response.writeHead(503, { 'content-type': 'text/html' });
        response.end('<title>Unavailable</title>');
        return;
      }
      if (request.url === '/start-login') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(`<a href="${externalUrl}/login-redirect">Sign in</a>`);
        return;
      }
      if (request.url === '/after-login') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<h1>Signed in</h1>');
        return;
      }
      if (request.url === '/local-redirect') {
        response.writeHead(302, { location: '/after-login' });
        response.end();
        return;
      }
      if (request.url === '/origin-guard') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(`<title>Origin guard</title><script>
          fetch('/health').then(r => r.json()).then(() => {
            document.body.innerHTML = '<h1>' + location.origin + '</h1>';
          }).catch(error => { document.body.innerHTML = '<h1>Origin rejected: ' + error.message + '</h1>'; });
        </script>`);
        return;
      }
      if (request.url === '/protected') {
        if (
          request.headers['cf-access-client-id'] !== 'client-id' ||
          request.headers['cf-access-client-secret'] !== 'client-secret'
        ) {
          response.writeHead(403).end('Access denied');
          return;
        }
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          `<title>Protected</title><h1>Protected app</h1><img src="${externalUrl}/pixel.png">`,
        );
        return;
      }
      if (request.url === '/openapi.json') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"openapi":"3.0.0","paths":{"/health":{}}}');
        return;
      }
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"status":"ok"}');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(request.url === '/about' ? '<title>Sobre</title><h1>Sobre</h1>' : page);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => externalServer.close(resolve));
    await new Promise((resolve) => apiServer.close(resolve));
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('explores the UI and follows same-origin links', async () => {
    const snapshot = await runner.explore({ mode: 'frontend', url: `${baseUrl}/` });
    expect(snapshot.pages[0]).toMatchObject({
      title: 'Evento de teste',
      headings: ['Evento de teste'],
      buttons: ['Enviar pergunta'],
      testIds: ['send'],
    });
    expect(snapshot.pages[0]?.fields[0]).toContain('label="Qual a sua pergunta?"');
    expect(snapshot.pages.map((item) => item.title)).toContain('Sobre');
  }, 60_000);

  it('keeps the localhost browser origin while loading pages through the public transport', async () => {
    const localOrigin = 'http://localhost:43123';
    const snapshot = await runner.explore({
      mode: 'frontend',
      url: `${localOrigin}/origin-guard`,
      transportUrl: baseUrl,
    });
    expect(snapshot.pages[0]?.url).toBe(`${localOrigin}/origin-guard`);
    expect(snapshot.pages[0]?.headings).toContain(localOrigin);

    const result = await runner.run({
      mode: 'frontend',
      baseUrl,
      localOrigin,
      locale: 'en-US',
      credentials: { username: null, password: null },
      script: `import { test, expect } from '@playwright/test';
test('local browser origin', async ({ page, request }) => {
  await page.goto('/origin-guard');
  await expect(page.getByRole('heading', { name: '${localOrigin}' })).toBeVisible();
  expect(new URL(page.url()).origin).toBe('${localOrigin}');
  expect((await request.get('/health')).status()).toBe(200);
});`,
    });
    expect(result.status, result.error ?? result.logs).toBe('passed');
  }, 120_000);

  it('loads a second local API and SSO discovery through an authenticated gateway', async () => {
    const token = { clientId: 'adk-local-browser', clientSecret: 'gateway-secret' };
    const gateway = createLocalGateway(baseUrl, token);
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    const gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
    try {
      const result = await runner.run({
        mode: 'frontend',
        baseUrl: gatewayUrl,
        localOrigin: 'http://localhost:43123',
        locale: 'en-US',
        accessToken: token,
        credentials: { username: null, password: null },
        script: `import { test, expect } from '@playwright/test';
test('fullstack local app with SSO', async ({ page }) => {
  await page.goto('/fullstack');
  await expect(page.getByRole('heading', { name: 'api ready / mock-sso' })).toBeVisible();
  expect(new URL(page.url()).origin).toBe('http://localhost:43123');
});`,
      });
      expect(result.status, result.steps[0]?.error ?? result.error ?? result.logs).toBe('passed');
    } finally {
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  }, 120_000);

  it('loads a local callback after an external login redirect', async () => {
    const result = await runner.run({
      mode: 'frontend',
      baseUrl,
      localOrigin: 'http://localhost:43123',
      locale: 'en-US',
      credentials: { username: null, password: null },
      script: `import { test, expect } from '@playwright/test';
test('external login redirect', async ({ page }) => {
  await test.step('Sign in', async () => {
    await page.goto('/local-redirect');
    await expect(page.getByRole('heading', { name: 'Signed in' })).toBeVisible();
    await page.goto('/start-login');
    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Signed in' })).toBeVisible({ timeout: 3000 });
  });
});`,
    });
    expect(result.status, result.steps[0]?.error ?? result.error ?? undefined).toBe('passed');
  }, 120_000);

  it('explores an API and discovers its OpenAPI document', async () => {
    const snapshot = await runner.explore({ mode: 'backend', url: `${baseUrl}/health` });
    expect(snapshot.api).toMatchObject({ status: 200, specUrl: '/openapi.json' });
  });

  it('reports unreachable targets', async () => {
    await expect(
      runner.explore({ mode: 'frontend', url: 'http://127.0.0.1:1/' }),
    ).rejects.toMatchObject({ code: 'E2E_TARGET_UNREACHABLE' });
  }, 60_000);

  it('uses Access headers for the target origin without leaking them to another origin', async () => {
    externalHeaders.length = 0;
    const accessToken = { clientId: 'client-id', clientSecret: 'client-secret' };
    const snapshot = await runner.explore({
      mode: 'frontend',
      url: `${baseUrl}/protected`,
      accessToken,
    });
    expect(snapshot.pages[0]?.headings).toContain('Protected app');
    expect(externalHeaders).toContain('');
    expect(externalHeaders).not.toContain('client-secret');

    const result = await runner.run({
      mode: 'frontend',
      baseUrl,
      locale: 'en-US',
      accessToken,
      credentials: { username: null, password: null },
      script: `import { test, expect } from '@playwright/test';
test('protected page', async ({ page, request }) => {
  await page.goto('/protected');
  await expect(page.getByRole('heading', { name: 'Protected app' })).toBeVisible();
  const target = await request.get('/protected');
  expect(target.status()).toBe(200);
  await request.get('${externalUrl}/pixel.png');
});`,
    });
    expect(result.status).toBe('passed');
    expect(result.logs).not.toContain('client-secret');
    expect(externalHeaders).not.toContain('client-secret');
  }, 120_000);

  it('runs a passing UI test, records a video and redacts credentials', async () => {
    const result = await runner.run({
      mode: 'frontend',
      baseUrl,
      locale: 'pt-BR',
      credentials: { username: 'qa@example.com', password: 'super-secret' },
      script: `import { test, expect } from '@playwright/test';
test('submit question', async ({ page }) => {
  console.log('user', process.env.E2E_USERNAME, process.env.E2E_PASSWORD);
  await page.goto('/');
  await page.getByLabel('Qual a sua pergunta?').fill('Essa é uma pergunta de teste');
  await page.getByRole('button', { name: 'Enviar pergunta' }).click();
  await expect(page.getByText('Essa é uma pergunta de teste')).toBeVisible();
});`,
    });
    expect(result.status).toBe('passed');
    expect(result.error).toBeNull();
    expect(result.video?.byteLength).toBeGreaterThan(1000);
    expect(result.logs).not.toContain('super-secret');
    expect(result.logs).not.toContain('qa@example.com');

    // The recording converts to an H.264 MP4 that VS Code's browser can play.
    const ffmpegPath = resolveFfmpegPath();
    if (ffmpegPath) {
      const mp4 = await new FfmpegVideoTranscoder({ ffmpegPath }).toMp4(result.video!);
      expect(Buffer.from(mp4!).subarray(4, 8).toString()).toBe('ftyp');
      // The recording keeps the final screen after the last step instead of cutting it.
      const probe = path.join(workspaceRoot, 'probe.mp4');
      fs.writeFileSync(probe, mp4!);
      const info = await runProcess({
        command: ffmpegPath,
        args: ['-hide_banner', '-i', probe],
        cwd: workspaceRoot,
        env: process.env,
        timeoutMs: 10_000,
      });
      const [, h, m, s] = /Duration: (\d+):(\d+):([\d.]+)/.exec(info.stderr) ?? [];
      expect(Number(h) * 3600 + Number(m) * 60 + Number(s)).toBeGreaterThan(FINAL_HOLD_MS / 1000);
    }
  }, 120_000);

  it('runs a failing test and returns the assertion error', async () => {
    const result = await runner.run({
      mode: 'frontend',
      baseUrl,
      locale: 'en-US',
      credentials: { username: null, password: null },
      script: `import { test, expect } from '@playwright/test';
test('wrong heading', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Não existe' })).toBeVisible({ timeout: 1000 });
});`,
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('toBeVisible');
    expect(result.video).not.toBeNull();
  }, 120_000);

  it('records each top-level step with a screenshot, stopping at the failing one', async () => {
    const result = await runner.run({
      mode: 'frontend',
      baseUrl,
      locale: 'pt-BR',
      credentials: { username: null, password: null },
      script: `import { test, expect } from '@playwright/test';
test('TC001 - Enviar pergunta', async ({ page }) => {
  await test.step('Passo 1 - Abrir o evento', async () => {
    await page.goto('/');
    await test.step('nested detail', async () => {
      await expect(page.getByRole('heading', { name: 'Evento de teste' })).toBeVisible();
    });
  });
  await test.step('Passo 2 - Enviar a pergunta', async () => {
    await page.getByLabel('Qual a sua pergunta?').fill('Pergunta com evidência');
    await page.getByRole('button', { name: 'Enviar pergunta' }).click();
    await expect(page.getByText('Pergunta com evidência')).toBeVisible();
  });
  await test.step('Passo 3 - Ver a resposta', async () => {
    await expect(page.getByText('Resposta inexistente')).toBeVisible({ timeout: 1000 });
  });
  await test.step('Passo 4 - Nunca executado', async () => {
    await page.goto('/about');
  });
});`,
    });
    expect(result.status).toBe('failed');
    expect(result.steps.map((step) => [step.position, step.title, step.status])).toEqual([
      [1, 'Passo 1 - Abrir o evento', 'passed'],
      [2, 'Passo 2 - Enviar a pergunta', 'passed'],
      [3, 'Passo 3 - Ver a resposta', 'failed'],
    ]);
    expect(result.steps[2]?.error).toContain('toBeVisible');
    expect(result.steps[2]?.error).toContain(`Browser origin at failure: ${baseUrl}`);
    for (const step of result.steps)
      expect(Buffer.from(step.screenshot!).subarray(1, 4).toString()).toBe('PNG');
  }, 120_000);

  it('reports unsuccessful document responses by origin without exposing query parameters', async () => {
    const result = await runner.run({
      mode: 'frontend',
      baseUrl,
      locale: 'en-US',
      credentials: { username: null, password: null },
      script: `import { test, expect } from '@playwright/test';
test('network diagnostics', async ({ page }) => {
  await test.step('Open unavailable page', async () => {
    await page.goto('/broken?secret=do-not-log');
    await expect(page.getByRole('heading', { name: 'Ready' })).toBeVisible({ timeout: 1000 });
  });
});`,
    });
    expect(result.status).toBe('failed');
    const networkLine = result.steps[0]?.error
      ?.split('\n')
      .find((line) => line.startsWith('Browser network:'));
    expect(networkLine).toBe(`Browser network: HTTP 503 (document) from ${baseUrl}`);
    expect(networkLine).not.toContain('do-not-log');
  }, 120_000);

  it('records API steps without screenshots', async () => {
    const result = await runner.run({
      mode: 'backend',
      baseUrl,
      locale: 'en-US',
      credentials: { username: null, password: null },
      script: `import { test, expect } from '@playwright/test';
test('TC001 - Health', async ({ request }) => {
  await test.step('Step 1 - Call health', async () => {
    expect((await request.get('/health')).status()).toBe(200);
  });
});`,
    });
    expect(result.status).toBe('passed');
    expect(result.steps).toEqual([
      expect.objectContaining({ position: 1, status: 'passed', screenshot: null }),
    ]);
  }, 120_000);

  it('reports syntax errors as failures', async () => {
    const result = await runner.run({
      mode: 'backend',
      baseUrl,
      locale: 'en-US',
      credentials: { username: null, password: null },
      script: `import { test } from '@playwright/test';\ntest('broken', async () => { const = ; });`,
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
    expect(result.video).toBeNull();
  }, 120_000);

  it('uses an OS default browsers path', () => {
    expect(defaultBrowsersPath()).toContain(os.homedir());
  });
});
