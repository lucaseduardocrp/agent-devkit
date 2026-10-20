import fs from 'node:fs/promises';
import path from 'node:path';
import { AdkApiError, segment, type AdkApi } from '@agent-devkit/mcp';
import type { LocalRunnerAgent } from './agent.js';

interface CreationDto {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly executionTarget?: 'remote' | 'local';
  readonly baseUrl: string;
  readonly error: string | null;
  readonly tests?: readonly TestDto[];
}

interface TestDto {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly status: string;
  readonly error: string | null;
  readonly durationMs: number | null;
}

const ACTIVE = new Set(['queued', 'planning', 'running']);

export interface LocalRunOptions {
  readonly creationId: string;
  /** One test (id or code such as TC001) instead of the whole run. */
  readonly test?: string;
  /** Folder with edited specs pushed to the run's repository before running. */
  readonly scriptsDir?: string;
  /** Switches a run that executes on the ADK workers to this computer. */
  readonly setLocal?: boolean;
  readonly signal?: AbortSignal;
}

export interface LocalRunSummary {
  readonly creation: CreationDto;
  readonly passed: number;
  readonly failed: number;
}

/**
 * `devkit e2e run`: starts a run from the terminal and executes it on this computer.
 * Planning, healing and results stay in ADK; only the browser runs here.
 */
export async function runLocally(
  api: AdkApi,
  agent: Pick<LocalRunnerAgent, 'serve'>,
  options: LocalRunOptions,
  say: (line: string) => void,
): Promise<LocalRunSummary> {
  const runPath = `/e2e/creations/${segment(options.creationId)}`;
  let creation = await getCreation(api, runPath);
  if (creation.executionTarget !== 'local') {
    if (!options.setLocal)
      throw new Error(
        `"${creation.name}" runs on the ADK servers. Pass --set-local to run it on this computer from now on (switch it back in ADK at any time).`,
      );
    ({ creation } = await api.request<{ creation: CreationDto }>({
      method: 'PUT',
      path: `${runPath}/execution`,
      body: { executionTarget: 'local' },
    }));
    say(`"${creation.name}" now runs on this computer (${creation.baseUrl}).`);
  }
  const test = options.test ? findTest(creation, options.test) : undefined;
  if (options.scriptsDir) await pushScripts(api, creation, test, options.scriptsDir, say);
  try {
    await api.request({
      method: 'POST',
      path: test ? `/e2e/tests/${segment(test.id)}/run` : `${runPath}/run`,
    });
    say(test ? `Started ${test.code} - ${test.title}.` : `Started "${creation.name}".`);
  } catch (error) {
    if (!(error instanceof AdkApiError && error.code === 'E2E_ALREADY_RUNNING')) throw error;
    say(`"${creation.name}" is already running; executing its browser work here.`);
  }
  await agent.serve({
    creationId: creation.id,
    waitSeconds: 5,
    ...(options.signal ? { signal: options.signal } : {}),
    done: async () => !ACTIVE.has((creation = await getCreation(api, runPath)).status),
  });
  if (options.signal?.aborted) {
    // Stopped here (Ctrl+C): stop the run in ADK too instead of letting it wait for a runner.
    await api.request({ method: 'POST', path: `${runPath}/cancel` }).catch(() => undefined);
    say(`Cancelled "${creation.name}" in ADK.`);
  }
  creation = await getCreation(api, runPath);
  const tests = (creation.tests ?? []).filter((item) => !test || item.id === test.id);
  for (const item of tests) say(describeTest(item));
  if (creation.error) say(creation.error);
  return {
    creation,
    passed: tests.filter((item) => item.status === 'passed').length,
    failed: tests.filter((item) => ['failed', 'error'].includes(item.status)).length,
  };
}

async function getCreation(api: AdkApi, runPath: string): Promise<CreationDto> {
  return (await api.request<{ creation: CreationDto }>({ method: 'GET', path: runPath })).creation;
}

function findTest(creation: CreationDto, value: string): TestDto {
  const wanted = value.trim().toLowerCase();
  const test = (creation.tests ?? []).find(
    (item) => item.id === value || item.code.toLowerCase() === wanted,
  );
  if (!test) throw new Error(`Test "${value}" is not part of "${creation.name}".`);
  return test;
}

/**
 * Commits the local versions of the run's specs (matched by file name) to its repository,
 * so ADK keeps the scripts that ran. Files of other tests are left alone.
 */
async function pushScripts(
  api: AdkApi,
  creation: CreationDto,
  only: TestDto | undefined,
  folder: string,
  say: (line: string) => void,
): Promise<void> {
  const local = new Set(
    (await fs.readdir(folder)).filter((name) => /\.spec\.(ts|js|mjs)$/.test(name)),
  );
  const matched = new Set<string>();
  for (const test of (creation.tests ?? []).filter((item) => !only || item.id === only.id)) {
    const script = await api.request<{ path: string; content: string | null }>({
      method: 'GET',
      path: `/e2e/tests/${segment(test.id)}/script`,
    });
    const name = path.posix.basename(script.path);
    if (!local.has(name)) continue;
    matched.add(name);
    const content = await fs.readFile(path.join(folder, name), 'utf8');
    if (normalize(content) === normalize(script.content ?? '')) continue;
    await api.request({
      method: 'PUT',
      path: `/e2e/tests/${segment(test.id)}/script`,
      body: { content },
    });
    say(`Pushed ${test.code} script (${script.path}).`);
  }
  if (!only)
    for (const name of [...local].filter((item) => !matched.has(item)).sort())
      say(`Skipped ${name}: no test of this run uses it.`);
}

function normalize(content: string): string {
  return content.replace(/\r\n/g, '\n').trimEnd();
}

function describeTest(test: TestDto): string {
  const mark =
    test.status === 'passed' ? '✔' : ['failed', 'error'].includes(test.status) ? '✖' : '•';
  const time = test.durationMs === null ? '' : ` (${(test.durationMs / 1000).toFixed(1)}s)`;
  const error = test.error ? `\n    ${test.error.split('\n')[0]}` : '';
  return `${mark} ${test.code} ${test.title} — ${test.status}${time}${error}`;
}
