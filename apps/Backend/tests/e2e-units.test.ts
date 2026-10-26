import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  normalizeScriptFolder,
  normalizeLocalBrowserOrigin,
  normalizeTargetUrl,
  scriptFilePath,
  slugify,
  targetUrl,
  testCaseCode,
} from '../src/modules/e2e/domain/e2e.js';
import { specTitle } from '../src/modules/e2e/application/e2e-service.js';
import { checkScript, stripCodeFence } from '../src/modules/e2e/application/script-guard.js';
import {
  FileSystemE2eArtifactStore,
  InMemoryE2eArtifactStore,
} from '../src/modules/e2e/application/artifact-store.js';
import { InMemoryE2eStore } from '../src/modules/e2e/application/e2e-store.js';
import { PrismaE2eStore } from '../src/modules/e2e/adapters/prisma-e2e-store.js';
import { redact, stripAnsi } from '../src/modules/e2e/application/e2e-runner.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

const newCreation = {
  workspaceId: 'ws',
  ownerId: 'ws',
  actorId: 'u',
  agentId: 'a',
  name: 'run',
  mode: 'frontend' as const,
  scope: 'codebase' as const,
  baseUrl: 'http://localhost:3000',
  path: '/',
  username: null,
  passwordSecret: null,
  prd: 'prd',
  prdFileNames: ['a.md'],
  diff: null,
  instructions: null,
  locale: 'pt-BR',
  repository: {
    provider: 'github' as const,
    id: '42',
    name: 'acme/demo-app',
    branch: 'main',
    path: 'tests/e2e',
  },
};

describe('E2E domain', () => {
  it('formats test codes and target URLs', () => {
    expect(testCaseCode(1)).toBe('TC001');
    expect(testCaseCode(12)).toBe('TC012');
    expect(targetUrl({ baseUrl: 'http://x:1', path: '/a' })).toBe('http://x:1/a');
  });

  it('normalizes target URLs and blocks unsafe ones', () => {
    expect(normalizeTargetUrl('http://localhost:3000/', 'e/123')).toEqual({
      baseUrl: 'http://localhost:3000',
      path: '/e/123',
    });
    expect(normalizeTargetUrl(' https://app.test/dashboard ')).toEqual({
      baseUrl: 'https://app.test',
      path: '/dashboard',
    });
    expect(normalizeTargetUrl('http://localhost:3000', '//a')).toMatchObject({ path: '/a' });
    for (const url of [
      'not a url',
      'file:///etc/passwd',
      'http://user:pw@host',
      'http://169.254.169.254/latest',
      'http://169.254.1.1',
      'http://metadata.google.internal',
    ])
      expect(() => normalizeTargetUrl(url)).toThrow(
        expect.objectContaining({ code: 'E2E_INVALID_URL' }),
      );
  });

  it('accepts only a loopback HTTP browser origin for frontend tunnels', () => {
    expect(normalizeLocalBrowserOrigin('http://localhost:8014/', 'frontend')).toBe(
      'http://localhost:8014',
    );
    expect(normalizeLocalBrowserOrigin('', 'frontend')).toBeNull();
    expect(
      targetUrl({
        baseUrl: 'https://tunnel.example',
        localOrigin: 'http://localhost:8014',
        path: '/login',
      }),
    ).toBe('http://localhost:8014/login');
    for (const value of [
      'https://localhost:8014',
      'http://example.com',
      'http://localhost:8014/login',
    ])
      expect(() => normalizeLocalBrowserOrigin(value, 'frontend')).toThrow(
        expect.objectContaining({ code: 'E2E_INVALID_URL' }),
      );
    expect(() => normalizeLocalBrowserOrigin('http://localhost:8014', 'backend')).toThrow(
      expect.objectContaining({ code: 'E2E_INVALID_URL' }),
    );
  });
});

describe('script locations', () => {
  it('normalizes the repository folder and rejects escapes', () => {
    expect(normalizeScriptFolder(' /tests\\e2e/ ')).toBe('tests/e2e');
    expect(normalizeScriptFolder('')).toBe('');
    expect(normalizeScriptFolder('///')).toBe('');
    for (const bad of ['../x', 'a/./b', 'a//b', 'tests/$(rm)', 'x'.repeat(301)])
      expect(() => normalizeScriptFolder(bad)).toThrow(
        expect.objectContaining({ code: 'E2E_INVALID_SCRIPT_PATH' }),
      );
  });

  it('names spec files after the test', () => {
    expect(slugify('Ação de Votação: só uma vez!')).toBe('acao-de-votacao-so-uma-vez');
    expect(slugify('!!!')).toBe('test');
    expect(slugify(`${'a'.repeat(59)} bc`, 60)).toBe('a'.repeat(59));
    expect(scriptFilePath('tests/e2e', { code: 'TC003', title: 'Login válido' })).toBe(
      'tests/e2e/tc003-login-valido.spec.ts',
    );
    expect(scriptFilePath('', { code: 'TC001', title: 'Home' })).toBe('tc001-home.spec.ts');
  });

  it('titles imported specs from their test name or file name', () => {
    expect(specTitle("test('TC010 - Checkout', () => {})", 'a/x.spec.ts')).toBe('Checkout');
    expect(specTitle('test("Login works", () => {})', 'a/x.spec.ts')).toBe('Login works');
    expect(specTitle('export {}', 'tests/e2e/cart-flow.spec.ts')).toBe('cart-flow');
    expect(specTitle("test('TC001 - ', () => {})", 'flow.spec.mjs')).toBe('flow');
  });
});

describe('script guard', () => {
  const ok = `import { test, expect } from '@playwright/test';
// Checkout process: the user process is described in the PRD
test('TC001 - checkout process', async ({ page, request }) => {
  const items = ['a', 'b'];
  for (const item of ['x']) console.log(item, items[0]);
  await page.goto('/');
  await page.getByLabel('Email').fill(process.env.E2E_USERNAME ?? '');
  await page.getByLabel('Password').fill(process.env.E2E_PASSWORD ?? '');
  await page.locator('input[name="path"]').fill('channel');
  await expect(page.getByText("Saved: process done")).toBeVisible();
  const response = await request.get(\`\${process.env.E2E_BASE_URL}/health\`);
  expect(response.ok()).toBeTruthy();
});`;

  it('accepts browser and API automation with the allowed env vars', () => {
    expect(checkScript(ok)).toEqual({ ok: true, violations: [] });
  });

  it.each([
    ["import fs from 'node:fs';", 'import from "node:fs" is not allowed'],
    ["import 'dotenv/config';", 'import from "dotenv/config" is not allowed'],
    ["const fs = require('fs');", 'require() is not allowed'],
    ["await import('fs');", 'dynamic import() is not allowed'],
    ['console.log(process.env.DATABASE_URL);', 'process access is not allowed'],
    ['globalThis.fetch;', 'global object access is not allowed'],
    ["eval('1');", 'dynamic code is not allowed'],
    ['[].constructor;', 'prototype access is not allowed'],
    ['console.log(__dirname);', 'runtime globals are not allowed'],
    ['await chromium.launch();', 'launching browsers directly is not allowed'],
    ['await browser.launchPersistentContext();', 'launching browsers directly is not allowed'],
    ['const o = { executablePath: "x" };', 'browser launch options are not allowed'],
    ["await page.screenshot({ path: '/tmp/x.png' });", 'file paths are not allowed'],
    ["await page.setInputFiles('#f', 'a');", 'file access is not allowed'],
    ['test.use({ viewport: null });', 'overriding runner options is not allowed'],
    ["page['setInput' + 'Files']('a');", 'computed member access with strings is not allowed'],
  ])('rejects %s', (line, reason) => {
    const script = `import { test } from '@playwright/test';\ntest('x', async ({ page }) => {\n${line}\n});`;
    expect(checkScript(script).violations).toContain(reason);
  });

  it('requires a Playwright import, a test and a reasonable size', () => {
    expect(checkScript('  ')).toEqual({ ok: false, violations: ['script is empty'] });
    expect(checkScript('const a = 1;').violations).toEqual([
      'script must import @playwright/test',
      'script must declare a test()',
    ]);
    expect(
      checkScript(
        `import { test } from '@playwright/test';\ntest('x', () => {});\n//${'a'.repeat(60_001)}`,
      ).violations,
    ).toEqual(['script is too long']);
  });

  it('strips Markdown fences', () => {
    expect(stripCodeFence('Here:\n```typescript\nconst a = 1;\n```\nDone')).toBe('const a = 1;');
    expect(stripCodeFence('```ts title="x"\ncode\n```')).toBe('code');
    expect(stripCodeFence('  plain  ')).toBe('plain');
  });
});

describe('runner helpers', () => {
  it('redacts secrets and ANSI codes', () => {
    expect(redact('password: abc user=qa-user token=xyz', ['qa-user', 'ab', null])).toBe(
      'password: [redacted] user=[redacted] token=[redacted]',
    );
    expect(redact('Authorization: Bearer abc.def', [])).toBe('Authorization: [redacted]');
    expect(stripAnsi('\u001b[31mred\u001b[39m')).toBe('red');
  });
});

describe('artifact stores', () => {
  it('stores, reads and removes artifacts in memory', async () => {
    const store = new InMemoryE2eArtifactStore();
    await store.put('ws/run/a.webm', Buffer.from('a'));
    await store.put('ws/run2/b.webm', Buffer.from('b'));
    expect((await store.get('ws/run/a.webm'))?.toString()).toBe('a');
    await store.removePrefix('ws/run');
    expect(await store.get('ws/run/a.webm')).toBeNull();
    expect(await store.get('ws/run2/b.webm')).not.toBeNull();
    await store.removePrefix('ws/run2/b.webm');
    expect(await store.get('ws/run2/b.webm')).toBeNull();
    expect(() => store.put('../etc/passwd', Buffer.from(''))).toThrow('Invalid artifact key');
    expect(() => store.get('ws/./x')).toThrow('Invalid artifact key');
  });

  it('stores artifacts on disk', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-artifacts-'));
    const store = new FileSystemE2eArtifactStore(root);
    await store.put('ws/run/a.webm', Buffer.from('video'));
    expect((await store.get('ws/run/a.webm'))?.toString()).toBe('video');
    expect(await store.get('ws/run/missing.webm')).toBeNull();
    await store.removePrefix('ws/run');
    expect(fs.existsSync(path.join(root, 'ws', 'run'))).toBe(false);
    await expect(store.get('ws/../../x')).resolves.toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('InMemoryE2eStore', () => {
  it('scopes creations and tests to the workspace', async () => {
    const store = new InMemoryE2eStore();
    const creation = await store.createCreation(newCreation);
    const other = await store.createCreation({ ...newCreation, workspaceId: 'other' });
    expect(await store.getCreation('other', creation.id)).toBeNull();
    expect((await store.listCreations('ws')).map((item) => item.id)).toEqual([creation.id]);
    expect(await store.updateCreation('other', creation.id, { status: 'running' })).toBeNull();
    expect((await store.incompleteCreations()).map((item) => item.id)).toEqual([
      creation.id,
      other.id,
    ]);
    const [test] = await store.replaceTests(creation, [
      { title: 't', description: 'd', priority: 'high', steps: ['s'] },
    ]);
    expect(test).toMatchObject({ code: 'TC001', status: 'pending', attempts: 0 });
    expect(await store.getTest('other', test!.id)).toBeNull();
    expect(await store.updateTest('other', test!.id, { status: 'passed' })).toBeNull();
    expect(await store.listTests('ws', 'missing')).toEqual([]);
    expect(await store.deleteCreation('other', creation.id)).toBe(false);
    const appended = await store.appendTests(creation, [
      { title: 'Imported', description: '', priority: 'low', steps: [], scriptPath: 'x.spec.ts' },
    ]);
    expect(appended[0]).toMatchObject({ code: 'TC002', scriptPath: 'x.spec.ts' });
    expect(
      (
        await store.appendTests(other, [
          { title: 'o', description: '', priority: 'low', steps: [] },
        ])
      )[0]?.code,
    ).toBe('TC001');
    expect(await store.deleteCreation('ws', creation.id)).toBe(true);
    expect(await store.listTests('ws')).toEqual([]);
  });

  it('lists the most recently modified creation first', async () => {
    const store = new InMemoryE2eStore();
    const older = await store.createCreation(newCreation);
    const newer = await store.createCreation(newCreation);
    await store.updateCreation('ws', newer.id, { status: 'running' });
    await store.updateCreation('ws', older.id, { status: 'running' });
    vi.useFakeTimers({ now: Date.now() + 1000, toFake: ['Date'] });
    try {
      const [test] = await store.replaceTests(older, [
        { title: 't', description: 'd', priority: 'high', steps: ['s'] },
      ]);
      await store.updateTest('ws', test!.id, { status: 'passed' });
    } finally {
      vi.useRealTimers();
    }
    expect((await store.listCreations('ws')).map((item) => item.id)).toEqual([older.id, newer.id]);
  });

  it('updates tests whose creation is not kept by the store', async () => {
    const store = new InMemoryE2eStore();
    const detached = { ...(await store.createCreation(newCreation)), id: 'detached' };
    const [test] = await store.replaceTests(detached, [
      { title: 't', description: 'd', priority: 'high', steps: ['s'] },
    ]);
    expect(await store.updateTest('ws', test!.id, { status: 'passed' })).toMatchObject({
      status: 'passed',
    });
    expect(await store.getCreation('ws', 'detached')).toBeNull();
  });
});

describe('PrismaE2eStore', () => {
  function fakeDb() {
    const { repository: _repository, ...columns } = newCreation;
    const creationRow = {
      ...columns,
      repoProvider: 'github',
      repoId: '42',
      repoName: 'acme/demo-app',
      repoBranch: 'main',
      repoPath: null as string | null,
      id: 'c1',
      prdFileNames: ['a.md', 3],
      prdSummary: null,
      status: 'queued',
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      finishedAt: null,
    };
    const testRow = { id: 't1', creationId: 'c1', workspaceId: 'ws', steps: 'bad', position: 1 };
    const db = {
      e2eCreationRecord: {
        create: vi.fn().mockResolvedValue(creationRow),
        findFirst: vi.fn().mockResolvedValue(creationRow),
        findMany: vi.fn().mockResolvedValue([creationRow]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      e2eTestCaseRecord: {
        deleteMany: vi.fn().mockReturnValue('delete-op'),
        createMany: vi.fn().mockReturnValue('create-op'),
        findMany: vi.fn().mockResolvedValue([testRow]),
        findFirst: vi.fn().mockResolvedValue(testRow),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn().mockResolvedValue([]),
    };
    return { db, creationRow, store: new PrismaE2eStore(db as unknown as PrismaClient) };
  }

  it('maps rows and scopes queries by workspace', async () => {
    const { db, store, creationRow } = fakeDb();
    const created = await store.createCreation(newCreation);
    expect(created.prdFileNames).toEqual(['a.md']);
    expect(created.repository).toEqual({ ...newCreation.repository, path: '' });
    expect(db.e2eCreationRecord.create.mock.calls[0]![0].data).toMatchObject({
      repoProvider: 'github',
      repoId: '42',
      repoName: 'acme/demo-app',
      repoBranch: 'main',
      repoPath: 'tests/e2e',
    });
    expect(db.e2eCreationRecord.create.mock.calls[0]![0].data).not.toHaveProperty('repository');
    await store.createCreation({ ...newCreation, repository: null });
    expect(db.e2eCreationRecord.create.mock.calls[1]![0].data).toMatchObject({
      repoProvider: null,
      repoPath: null,
    });
    db.e2eCreationRecord.findFirst.mockResolvedValueOnce({ ...creationRow, repoProvider: null });
    expect((await store.getCreation('ws', 'c1'))?.repository).toBeNull();
    const appended = await store.appendTests(created, [
      {
        title: 'Imported',
        description: '',
        priority: 'medium',
        steps: [],
        scriptPath: 'a.spec.ts',
      },
    ]);
    expect(appended[0]).toMatchObject({ position: 2, code: 'TC002', scriptPath: 'a.spec.ts' });
    db.e2eTestCaseRecord.findFirst.mockResolvedValueOnce(null);
    expect(
      (
        await store.appendTests(created, [
          { title: 'x', description: '', priority: 'low', steps: [] },
        ])
      )[0]?.position,
    ).toBe(1);
    expect(await store.getCreation('ws', 'c1')).toMatchObject({ id: 'c1' });
    expect(await store.listCreations('ws')).toHaveLength(1);
    expect(await store.updateCreation('ws', 'c1', { status: 'running' })).toMatchObject({
      id: 'c1',
    });
    expect(db.e2eCreationRecord.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { status: 'running' } }),
    );
    await store.updateCreation('ws', 'c1', { name: 'n', repository: newCreation.repository });
    expect(db.e2eCreationRecord.updateMany.mock.lastCall![0].data).toEqual({
      name: 'n',
      repoProvider: 'github',
      repoId: '42',
      repoName: 'acme/demo-app',
      repoBranch: 'main',
      repoPath: 'tests/e2e',
    });
    expect(await store.deleteCreation('ws', 'c1')).toBe(true);
    expect(await store.incompleteCreations()).toHaveLength(1);
    const tests = await store.replaceTests((await store.getCreation('ws', 'c1'))!, [
      { title: 't', description: '', priority: 'low', steps: [] },
    ]);
    expect(db.$transaction).toHaveBeenCalledWith(['delete-op', 'create-op']);
    expect(tests[0]).toMatchObject({ code: 'TC001', creationId: 'c1' });
    expect((await store.listTests('ws', 'c1'))[0]?.steps).toEqual([]);
    expect(await store.listTests('ws')).toHaveLength(1);
    expect(db.e2eTestCaseRecord.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { workspaceId: 'ws' } }),
    );
    expect(await store.getTest('ws', 't1')).toMatchObject({ id: 't1' });
    expect(await store.updateTest('ws', 't1', { status: 'passed' })).toMatchObject({ id: 't1' });
    expect(db.e2eCreationRecord.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: 'c1', workspaceId: 'ws' } }),
    );
  });

  it('returns null for missing rows', async () => {
    const { db, store } = fakeDb();
    db.e2eCreationRecord.findFirst.mockResolvedValue(null);
    db.e2eCreationRecord.updateMany.mockResolvedValue({ count: 0 });
    db.e2eCreationRecord.deleteMany.mockResolvedValue({ count: 0 });
    db.e2eTestCaseRecord.findFirst.mockResolvedValue(null);
    expect(await store.getCreation('ws', 'x')).toBeNull();
    expect(await store.updateCreation('ws', 'x', {})).toBeNull();
    expect(await store.deleteCreation('ws', 'x')).toBe(false);
    expect(await store.getTest('ws', 'x')).toBeNull();
    expect(await store.updateTest('ws', 'x', {})).toBeNull();
    db.e2eTestCaseRecord.updateMany.mockResolvedValue({ count: 0 });
    expect(await store.updateTest('ws', 'x', {})).toBeNull();
  });
});
