import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AdkApi, type ApiRequest } from '#mcp';
import { runLocally } from '../src/e2e/local-runner/run-command.js';

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const creation = (overrides: Record<string, unknown> = {}) => ({
  id: 'c1',
  name: 'Checkout',
  status: 'completed',
  executionTarget: 'local',
  baseUrl: 'http://localhost:8014',
  error: null,
  tests: [
    { id: 't1', code: 'TC001', title: 'Pay', status: 'passed', error: null, durationMs: 1200 },
    { id: 't2', code: 'TC002', title: 'Refund', status: 'skipped', error: null, durationMs: null },
  ],
  ...overrides,
});

function fakeApi(routes: Record<string, unknown>) {
  const calls: ApiRequest[] = [];
  const api: AdkApi = {
    request: <T>(request: ApiRequest) => {
      calls.push(request);
      const value = routes[`${request.method} ${request.path}`];
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value as T);
    },
  };
  return { api, calls };
}

const serve = () => ({ serve: vi.fn(() => Promise.resolve()) });

describe('devkit e2e run branches', () => {
  it('starts the whole run and marks tests that neither passed nor failed', async () => {
    const { api, calls } = fakeApi({
      'GET /e2e/creations/c1': { creation: creation() },
      'POST /e2e/creations/c1/run': undefined,
    });
    const lines: string[] = [];
    const summary = await runLocally(api, serve(), { creationId: 'c1' }, (line) =>
      lines.push(line),
    );
    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain(
      'POST /e2e/creations/c1/run',
    );
    expect(lines).toEqual([
      'Started "Checkout".',
      '✔ TC001 Pay — passed (1.2s)',
      '• TC002 Refund — skipped',
    ]);
    expect(summary).toMatchObject({ passed: 1, failed: 0 });
  });

  it('copes with a run that lists no tests', async () => {
    const { api } = fakeApi({
      'GET /e2e/creations/c1': { creation: creation({ tests: undefined }) },
      'POST /e2e/creations/c1/run': undefined,
    });
    const lines: string[] = [];
    const summary = await runLocally(api, serve(), { creationId: 'c1' }, (line) =>
      lines.push(line),
    );
    expect(lines).toEqual(['Started "Checkout".']);
    expect(summary).toMatchObject({ passed: 0, failed: 0 });
    await expect(
      runLocally(api, serve(), { creationId: 'c1', test: 'TC001' }, () => undefined),
    ).rejects.toThrow('"TC001" is not part of "Checkout"');
  });

  it('finds a test by its id, and pushes only scripts that changed and that the run uses', async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-run-scripts-'));
    temporary.push(folder);
    await fs.writeFile(path.join(folder, 'tc001-pay.spec.ts'), 'edited');
    await fs.writeFile(path.join(folder, 'tc002-refund.spec.ts'), 'edited');
    await fs.writeFile(path.join(folder, 'notes.txt'), 'ignored');
    const { api, calls } = fakeApi({
      'GET /e2e/creations/c1': { creation: creation() },
      'GET /e2e/tests/t1/script': { path: 'tests/e2e/tc001-pay.spec.ts', content: null },
      'PUT /e2e/tests/t1/script': undefined,
      'POST /e2e/tests/t1/run': undefined,
    });
    const lines: string[] = [];
    await runLocally(api, serve(), { creationId: 'c1', test: 't1', scriptsDir: folder }, (line) =>
      lines.push(line),
    );
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({ content: 'edited' });
    expect(lines.slice(0, 2)).toEqual([
      'Pushed TC001 script (tests/e2e/tc001-pay.spec.ts).',
      'Started TC001 - Pay.',
    ]);
  });

  it('skips tests whose script is not in the local folder', async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-run-scripts-'));
    temporary.push(folder);
    await fs.writeFile(path.join(folder, 'unrelated.spec.ts'), 'x');
    const { api, calls } = fakeApi({
      'GET /e2e/creations/c1': { creation: creation() },
      'GET /e2e/tests/t1/script': { path: 'tests/e2e/tc001-pay.spec.ts', content: 'a' },
      'GET /e2e/tests/t2/script': { path: 'tests/e2e/tc002-refund.spec.ts', content: 'b' },
      'POST /e2e/creations/c1/run': undefined,
    });
    const lines: string[] = [];
    await runLocally(api, serve(), { creationId: 'c1', scriptsDir: folder }, (line) =>
      lines.push(line),
    );
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    expect(lines[0]).toBe('Skipped unrelated.spec.ts: no test of this run uses it.');
  });
});

describe('devkit e2e run scripts without tests', () => {
  it('pushes nothing for a run that lists no tests', async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-run-scripts-'));
    temporary.push(folder);
    const { api } = fakeApi({
      'GET /e2e/creations/c1': { creation: creation({ tests: undefined }) },
      'POST /e2e/creations/c1/run': undefined,
    });
    await expect(
      runLocally(api, serve(), { creationId: 'c1', scriptsDir: folder }, () => undefined),
    ).resolves.toBeDefined();
  });
});
