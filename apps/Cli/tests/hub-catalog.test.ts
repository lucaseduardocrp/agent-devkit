import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  fetchHubIndex,
  fetchLatestHubIndex,
  findItem,
  removalReason,
  satisfiesFloor,
  search,
  skillFileUrl,
} from '../src/hub/catalog.js';
import { hubFetch, hubIndex, pluginEntry, skillEntry } from './hub-fixtures.js';

describe('hub catalog', () => {
  it('loads and validates the index from a URL or a local file', async () => {
    const index = hubIndex();
    await expect(fetchHubIndex('https://hub.test/index.json', hubFetch(index))).resolves.toEqual(
      index,
    );

    const file = join(await mkdtemp(join(tmpdir(), 'hub-index-')), 'index.json');
    await writeFile(file, JSON.stringify(index));
    await expect(fetchHubIndex(file)).resolves.toEqual(index);
  });

  it('reports an unreachable hub and an index it does not understand', async () => {
    const down = vi.fn(() => Promise.resolve(new Response('', { status: 503 })));
    await expect(fetchHubIndex('https://hub.test/index.json', down)).rejects.toThrow(/503/);
    const future = vi.fn(() => Promise.resolve(Response.json({ schemaVersion: 2 })));
    await expect(fetchHubIndex('https://hub.test/index.json', future)).rejects.toThrow(
      /Update devkit/,
    );
  });

  it('loads the index at the newest commit of main, or from the branch when GitHub cannot say', async () => {
    const latest = hubIndex({ commit: 'e'.repeat(40) });
    const stale = hubIndex();
    const sha = 'f'.repeat(40);
    const serve = (apiAnswer: () => Promise<Response>) =>
      vi.fn((url: string | URL | Request) => {
        const href = String(url);
        if (href.startsWith('https://api.github.com/')) return apiAnswer();
        if (href.endsWith(`/${sha}/index.json`)) return Promise.resolve(Response.json(latest));
        if (href.endsWith('/main/index.json')) return Promise.resolve(Response.json(stale));
        return Promise.resolve(new Response('missing', { status: 404 }));
      });

    const ok = serve(() => Promise.resolve(new Response(`${sha}\n`)));
    await expect(fetchLatestHubIndex(ok)).resolves.toEqual(latest);
    expect(String(ok.mock.calls[0]![0])).toBe(
      'https://api.github.com/repos/lucaseduardocrp/agent-devkit-hub/commits/main',
    );

    const limited = serve(() => Promise.resolve(new Response('rate limit', { status: 403 })));
    await expect(fetchLatestHubIndex(limited)).resolves.toEqual(stale);
    const offline = serve(() => Promise.reject(new Error('offline')));
    await expect(fetchLatestHubIndex(offline)).resolves.toEqual(stale);
    const other = 'a'.repeat(40);
    const unpublished = serve(() => Promise.resolve(new Response(other)));
    await expect(fetchLatestHubIndex(unpublished)).resolves.toEqual(stale);
    expect(unpublished.mock.calls.map(([url]) => String(url))).toContain(
      `https://raw.githubusercontent.com/lucaseduardocrp/agent-devkit-hub/${other}/index.json`,
    );
  });

  it('refuses skill paths that escape the skill folder', async () => {
    const index = hubIndex({
      skills: [skillEntry({ files: [{ path: '../../.bashrc', size: 1, sha256: 'a'.repeat(64) }] })],
    });
    await expect(fetchHubIndex('https://hub.test/index.json', hubFetch(index))).rejects.toThrow();
  });

  it('builds raw file URLs at the indexed commit', () => {
    const index = hubIndex();
    expect(skillFileUrl(index, index.skills[0]!, 'SKILL.md')).toBe(
      `https://raw.githubusercontent.com/acme/adk/${'c'.repeat(40)}/skills/edge-hunter/SKILL.md`,
    );
  });

  it('builds raw file URLs from the repository and commit a skill is pinned to', () => {
    const builtIn = skillEntry({
      tier: 'built-in',
      path: 'apps/Mcp/skills/adk-brain',
      repository: 'acme/devkit',
      commit: 'd'.repeat(40),
    });
    expect(skillFileUrl(hubIndex({ skills: [builtIn] }), builtIn, 'SKILL.md')).toBe(
      `https://raw.githubusercontent.com/acme/devkit/${'d'.repeat(40)}/apps/Mcp/skills/adk-brain/SKILL.md`,
    );
  });

  it('blocks removed items by name or repository', () => {
    const index = hubIndex({
      removed: [
        {
          name: 'old',
          repo: 'https://github.com/Acme/Adk-Jira.git',
          reason: 'stole tokens',
          date: '2026-10-01',
        },
      ],
    });
    expect(removalReason(index, 'old')).toMatch(/stole tokens/);
    expect(removalReason(index, 'jira-qa', 'https://github.com/acme/adk-jira')).toMatch(
      /2026-10-01/,
    );
    expect(removalReason(index, 'jira-qa', 'https://github.com/acme/other')).toBeUndefined();
    expect(removalReason(index, 'jira-qa')).toBeUndefined();
  });

  it('finds items by name and suggests close matches', () => {
    const index = hubIndex();
    expect(findItem(index, 'skill', 'edge-hunter').name).toBe('edge-hunter');
    expect(findItem(index, 'plugin', 'jira-qa').title).toBe('Jira QA');
    expect(() => findItem(index, 'plugin', 'jira')).toThrow(/Did you mean jira-qa\?/);
    expect(() => findItem(index, 'skill', 'nothing-like-it')).toThrow(
      /No skill named "nothing-like-it" in the ADK Hub\.$/,
    );
  });

  it('searches names, descriptions, tags, maintainers and categories', () => {
    const index = hubIndex({
      skills: [
        skillEntry(),
        skillEntry({
          name: 'api-checks',
          description: 'REST contract tests.',
          tags: ['api'],
          category: 'api-testing',
        }),
      ],
    });
    expect(search(index, 'skill').map((item) => item.name)).toEqual(['edge-hunter', 'api-checks']);
    expect(search(index, 'skill', 'forms').map((item) => item.name)).toEqual(['edge-hunter']);
    expect(search(index, 'skill', 'REST, contract').map((item) => item.name)).toEqual([
      'api-checks',
    ]);
    expect(search(index, 'skill', '', 'api-testing').map((item) => item.name)).toEqual([
      'api-checks',
    ]);
    expect(search(index, 'plugin', 'acme')).toEqual([pluginEntry()]);
  });

  it('compares versions against a >= floor', () => {
    expect(satisfiesFloor('0.2.0', '>=0.1')).toBe(true);
    expect(satisfiesFloor('0.2.5', '>=0.2')).toBe(true);
    expect(satisfiesFloor('0.2.0', '>=0.2.0')).toBe(true);
    expect(satisfiesFloor('0.2.0', '>=0.2.1')).toBe(false);
    expect(satisfiesFloor('1.0.0', '>=0.9.9')).toBe(true);
    expect(satisfiesFloor('0.1.0', undefined)).toBe(true);
    expect(satisfiesFloor('dev', '>=1.0.0')).toBe(true);
  });
});
