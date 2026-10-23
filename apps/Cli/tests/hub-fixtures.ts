import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';
import type { HubIndex, HubPlugin, HubSkill } from '../src/hub/catalog.js';
import type { CheckoutPinned } from '../src/hub/install.js';

export const SKILL_FILES: Record<string, string> = {
  'SKILL.md': '---\nname: edge-hunter\ndescription: Find edge cases.\n---\n# Edge hunter\n',
  'references/list.md': '- empty\n- too long\n',
};

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

export function skillEntry(overrides: Partial<HubSkill> = {}, files = SKILL_FILES): HubSkill {
  return {
    name: 'edge-hunter',
    description: 'Use when the user wants edge cases for a form.',
    overview: 'Finds edge cases.',
    category: 'test-design',
    tags: ['qa', 'forms'],
    toolsets: ['testplans'],
    author: 'Ana',
    version: '1.0.0',
    license: 'MIT',
    tier: 'community',
    path: 'skills/edge-hunter',
    files: Object.entries(files).map(([path, content]) => ({
      path,
      size: content.length,
      sha256: digest(content),
    })),
    ...overrides,
  };
}

export function pluginEntry(overrides: Partial<HubPlugin> = {}): HubPlugin {
  return {
    name: 'jira-qa',
    title: 'Jira QA',
    description: 'Jira skills and MCP server for QA teams.',
    repo: 'https://github.com/acme/adk-jira',
    sha: 'a'.repeat(40),
    subdir: '',
    version: '1.0.0',
    maintainer: 'acme',
    tier: 'community',
    category: 'integrations',
    license: 'MIT',
    platforms: [],
    capabilities: {
      skills: ['jira-triage'],
      agents: ['jira-reviewer'],
      mcpServers: ['jira'],
      requiresEnv: ['JIRA_TOKEN'],
    },
    ...overrides,
  };
}

export function hubIndex(overrides: Partial<HubIndex> = {}): HubIndex {
  return {
    schemaVersion: 1,
    repository: 'acme/adk',
    commit: 'c'.repeat(40),
    generatedAt: '2026-10-22T12:00:00Z',
    categories: {
      skills: [{ id: 'test-design', icon: 'ti-list-check', label: { 'en-US': 'Test design' } }],
      plugins: [{ id: 'integrations', icon: 'ti-plug', label: { 'en-US': 'Integrations' } }],
    },
    skills: [skillEntry()],
    plugins: [pluginEntry()],
    removed: [],
    ...overrides,
  };
}

/** Serves the skill files from raw.githubusercontent.com and the index from hub.test. */
export function hubFetch(index: HubIndex, files: Record<string, string> = SKILL_FILES) {
  return vi.fn((url: string | URL | Request) => {
    const href = String(url);
    if (href === 'https://hub.test/index.json') return Promise.resolve(Response.json(index));
    const prefix = `https://raw.githubusercontent.com/${index.repository}/${index.commit}/skills/edge-hunter/`;
    const content = href.startsWith(prefix) ? files[href.slice(prefix.length)] : undefined;
    return Promise.resolve(
      content === undefined ? new Response('missing', { status: 404 }) : new Response(content),
    );
  });
}

export async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export interface PluginFiles {
  manifestName?: string;
  skills?: string[];
  mcp?: Record<string, unknown>;
  subdir?: string;
}

/** Fake checkout that writes a plugin package instead of running git. */
export function pluginCheckout(files: PluginFiles = {}): CheckoutPinned {
  return async (_repo, _sha, directory) => {
    const root = files.subdir ? join(directory, files.subdir) : directory;
    await write(
      join(root, 'adk-plugin.json'),
      JSON.stringify({ name: files.manifestName ?? 'jira-qa', version: '1.0.0' }),
    );
    for (const skill of files.skills ?? ['jira-triage']) {
      await write(join(root, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\n---\n`);
      await write(join(root, 'skills', skill, 'references', 'jql.md'), 'project = QA');
    }
    await write(join(root, 'agents', 'jira-reviewer.md'), '---\nname: jira-reviewer\n---\n');
    await write(
      join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: files.mcp ?? {
          jira: {
            command: 'npx',
            args: ['-y', 'jira-mcp@1.0.0'],
            env: { JIRA_TOKEN: '${JIRA_TOKEN}' },
          },
        },
      }),
    );
  };
}

export async function tempHome() {
  const root = await mkdtemp(join(tmpdir(), 'devkit-hub-'));
  return {
    root,
    lockFile: join(root, '.adk', 'hub-lock.json'),
    skillsDir: join(root, '.claude', 'skills'),
    agentsDir: join(root, '.claude', 'agents'),
  };
}
