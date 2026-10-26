import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runHubCommand, type HubCommandOptions } from '../src/hub/command.js';
import { formatInfo, formatInstalled, formatList, mcpInstructions } from '../src/hub/format.js';
import { HubInstaller } from '../src/hub/install.js';
import {
  hubFetch,
  hubIndex,
  pluginCheckout,
  pluginEntry,
  skillEntry,
  tempHome,
} from './hub-fixtures.js';

async function harness(index = hubIndex()) {
  const home = await tempHome();
  const said: string[] = [];
  const printed: string[] = [];
  const fetcher = hubFetch(index);
  const installer = new HubInstaller({
    lockFile: home.lockFile,
    fetch: fetcher,
    checkout: pluginCheckout(),
  });
  const run = (kind: 'skill' | 'plugin', args: string[], options: HubCommandOptions = {}) =>
    runHubCommand(
      kind,
      args,
      { hubUrl: 'https://hub.test/index.json', ...options },
      {
        say: (message) => said.push(message),
        print: (message) => printed.push(message),
        installer,
        fetch: fetcher,
        cwd: join(home.root, 'project'),
        home: home.root,
      },
    );
  return { home, said, printed, run, installer };
}

describe('devkit skills / plugins', () => {
  it('searches by default, with or without the search action', async () => {
    const { said, run } = await harness();
    await run('skill', []);
    await run('skill', ['forms']);
    await run('skill', ['search', 'nothing-matches']);
    await run('skill', ['list'], { category: 'test-design' });
    expect(said[0]).toMatch(/edge-hunter\s+community\s+Test design/);
    expect(said[1]).toMatch(/1 skill\. Details/);
    expect(said[2]).toBe('No skills found in the ADK Hub.');
    expect(said[3]).toMatch(/edge-hunter/);
  });

  it('prints JSON for search, info and installed', async () => {
    const { printed, run } = await harness();
    await run('plugin', ['search'], { json: true });
    await run('plugin', ['info', 'jira-qa'], { json: true });
    await run('skill', ['info', 'edge-hunter'], { json: true });
    await run('skill', ['installed'], { json: true });
    expect(JSON.parse(printed[0]!)).toEqual([pluginEntry()]);
    expect(JSON.parse(printed[1]!).name).toBe('jira-qa');
    expect(JSON.parse(printed[2]!).name).toBe('edge-hunter');
    expect(JSON.parse(printed[3]!)).toEqual([]);
  });

  it('shows details and requires names where needed', async () => {
    const { said, run } = await harness();
    await run('plugin', ['info', 'jira-qa']);
    expect(said[0]).toMatch(/Jira QA \(jira-qa\)/);
    for (const action of ['info', 'install', 'remove']) {
      await expect(run('skill', [action])).rejects.toThrow(/Usage: devkit skills/);
    }
  });

  it('installs a skill into the client folder and marks it in searches', async () => {
    const { home, said, run } = await harness();
    await run('skill', ['install', 'edge-hunter'], { client: 'codex' });
    expect(said[0]).toBe(
      `Installed skill edge-hunter 1.0.0 into ${join(home.root, '.codex', 'skills')}.`,
    );
    await run('skill', []);
    expect(said.at(-1)).toMatch(/^✓ edge-hunter/);
    await run('skill', ['installed']);
    expect(said.at(-1)).toMatch(/skill\s+edge-hunter\s+1\.0\.0/);
  });

  it('installs a plugin and tells the user how to register its MCP servers', async () => {
    const { home, said, run } = await harness();
    await run('plugin', ['install', 'jira-qa'], { scope: 'project' });
    const project = join(home.root, 'project');
    expect(said).toContain(
      `Installed plugin jira-qa 1.0.0 into ${join(project, '.claude', 'skills')}.`,
    );
    expect(
      said.some(
        (line) => line.includes('claude mcp add-json jira') && line.includes('--scope project'),
      ),
    ).toBe(true);
    expect(said).toContain('Set these environment variables first: JIRA_TOKEN.');
  });

  it('installs into --dir and refuses unknown clients', async () => {
    const { home, said, run } = await harness();
    await run('skill', ['install', 'edge-hunter'], { dir: join(home.root, 'custom'), force: true });
    expect(said[0]).toContain(join(home.root, 'custom'));
    await expect(run('skill', ['install', 'edge-hunter'], { client: 'emacs' })).rejects.toThrow(
      /Unknown client: emacs/,
    );
  });

  it('says when nothing is installed or everything is current', async () => {
    const { said, run } = await harness();
    await run('skill', ['update']);
    expect(said.at(-1)).toBe('No skills from the ADK Hub are installed.');
    await run('skill', ['install', 'edge-hunter']);
    await run('skill', ['update']);
    expect(said.at(-1)).toBe('Everything is up to date (1).');
  });

  it('prints updated and delisted items', async () => {
    const original = await harness();
    await original.run('skill', ['install', 'edge-hunter']);
    await original.run('plugin', ['install', 'jira-qa']);

    const bumped = hubIndex({
      skills: [],
      plugins: [pluginEntry({ sha: 'b'.repeat(40), version: '2.0.0' })],
    });
    const said: string[] = [];
    const context = {
      say: (message: string) => said.push(message),
      print: () => undefined,
      installer: new HubInstaller({
        lockFile: original.home.lockFile,
        fetch: hubFetch(bumped),
        checkout: pluginCheckout(),
      }),
      fetch: hubFetch(bumped),
    };
    await runHubCommand(
      'plugin',
      ['update', 'jira-qa'],
      { hubUrl: 'https://hub.test/index.json' },
      context,
    );
    await runHubCommand('skill', ['update'], { hubUrl: 'https://hub.test/index.json' }, context);
    expect(said[0]).toMatch(/Updated plugin jira-qa to 2\.0\.0/);
    expect(said[1]).toMatch(/edge-hunter is no longer in the ADK Hub/);
    expect(said).toHaveLength(2);
  });

  it('removes items and mentions MCP servers left registered', async () => {
    const { said, run } = await harness();
    await run('plugin', ['install', 'jira-qa']);
    await run('plugin', ['remove', 'jira-qa'], { client: 'claude' });
    expect(said.some((line) => line.startsWith('Removed plugin jira-qa'))).toBe(true);
    expect(said.some((line) => line.includes('claude mcp remove jira'))).toBe(true);
    await run('skill', ['install', 'edge-hunter']);
    await run('skill', ['remove', 'edge-hunter']);
    expect(said.at(-1)).toMatch(/Removed skill edge-hunter/);
  });
});

describe('devkit skills / plugins defaults', () => {
  it('reads the newest hub index and resolves folders from the user home and working directory', async () => {
    const home = await tempHome();
    const index = hubIndex();
    const fetcher = vi.fn((url: string | URL | Request) =>
      Promise.resolve(
        String(url).endsWith('/main/index.json')
          ? Response.json(index)
          : new Response('rate limit', { status: 403 }),
      ),
    );
    const said: string[] = [];
    const context = {
      say: (message: string) => said.push(message),
      print: () => undefined,
      installer: new HubInstaller({ lockFile: home.lockFile, fetch: fetcher }),
      fetch: fetcher,
    };
    await runHubCommand('skill', ['edge'], {}, context);
    expect(said[0]).toMatch(/edge-hunter/);
    for (const scope of ['user', 'project'] as const)
      await expect(
        runHubCommand('skill', ['remove', 'edge-hunter'], { scope }, context),
      ).rejects.toThrow('was not installed with devkit');
    expect(said).toHaveLength(1);
  });
});

describe('hub output', () => {
  const index = hubIndex();

  it('lists items and says when nothing is installed', () => {
    expect(
      formatList(index, 'plugin', [pluginEntry({ tier: 'verified', category: 'unknown' })]),
    ).toMatch(/jira-qa\s+verified\s+unknown/);
    expect(formatInstalled([])).toMatch(/Nothing from the ADK Hub is installed/);
    expect(
      formatInstalled([
        {
          kind: 'skill',
          name: 'edge-hunter',
          version: '',
          revision: 'b'.repeat(64),
          skillsDir: '/skills',
          paths: [],
          mcpServers: [],
          installedAt: '2026-10-23T12:00:00Z',
        },
      ]),
    ).toBe(`skill   edge-hunter  ${'b'.repeat(12)}  → /skills`);
    expect(
      formatList(index, 'skill', [skillEntry(), skillEntry({ name: 'other-skill' })]),
    ).toContain('2 skills.');
    expect(formatList(index, 'skill', [skillEntry({ description: 'x'.repeat(100) })])).toContain(
      '…',
    );
  });

  it('describes skills and plugins', () => {
    const skill = formatInfo(index, 'skill', skillEntry({ tags: [], toolsets: [], version: '' }));
    expect(skill).toContain('Version      -');
    expect(skill).not.toContain('Tags');
    expect(skill).toContain(
      `https://github.com/acme/adk/tree/${'c'.repeat(40)}/skills/edge-hunter`,
    );
    expect(formatInfo(index, 'skill', skillEntry())).toContain('ADK tools    testplans');

    const plugin = formatInfo(
      index,
      'plugin',
      pluginEntry({
        version: undefined,
        subdir: 'pkg',
        platforms: ['linux'],
        requiresDevkit: '>=0.2.0',
        disclosure: 'Sends issue text to Jira.',
        capabilities: { skills: [], agents: [], mcpServers: ['jira'], requiresEnv: [] },
      }),
    );
    expect(plugin).toContain(`Version      ${'a'.repeat(12)}`);
    expect(plugin).toContain('(pkg)');
    expect(plugin).toContain('Skills       -');
    const bare = formatInfo(
      index,
      'plugin',
      pluginEntry({ capabilities: { skills: [], agents: [], mcpServers: [], requiresEnv: [] } }),
    );
    expect(bare).toContain('MCP servers  -');
    expect(bare).toContain('Needs env    -');
    expect(plugin).toContain('Platforms    linux');
    expect(plugin).toContain('Needs devkit >=0.2.0');
    expect(plugin).toContain('Disclosure: Sends issue text to Jira.');
    expect(formatInfo(index, 'plugin', pluginEntry())).toContain(
      'Version      1.0.0 @ aaaaaaaaaaaa',
    );
  });

  it('writes MCP registration commands for each client', () => {
    const servers = {
      jira: { command: 'npx', args: ['-y', 'jira mcp'], env: { JIRA_TOKEN: "it's" } },
      docs: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } },
      bare: { command: 'server' },
      sse: { type: 'sse', url: 'https://mcp.example.com/sse' },
    };
    const claude = mcpInstructions('claude', 'user', servers);
    expect(claude[1]).toBe(
      `  claude mcp add-json jira '{"type":"stdio","command":"npx","args":["-y","jira mcp"],"env":{"JIRA_TOKEN":"it'\\''s"}}' --scope user`,
    );
    expect(claude[2]).toContain('"type":"http","url":"https://mcp.example.com/mcp","headers"');
    expect(claude[3]).toContain('{"type":"stdio","command":"server","args":[],"env":{}}');
    expect(claude[4]).toContain('"type":"sse"');
    const codex = mcpInstructions('codex', 'user', servers);
    expect(codex[1]).toBe(`  codex mcp add jira --env 'JIRA_TOKEN=it'\\''s' -- npx -y 'jira mcp'`);
    expect(codex[2]).toBe('  codex mcp add docs --url https://mcp.example.com/mcp');
    expect(codex[3]).toBe('  codex mcp add bare -- server');
    expect(mcpInstructions('agents', 'user', { bare: { command: 'server' } })[1]).toContain(
      '"mcpServers"',
    );
    expect(mcpInstructions('claude', 'user', {})).toEqual([]);
    // A plugin's .mcp.json may leave the command out; the command shows that nothing would run.
    expect(mcpInstructions('codex', 'user', { broken: {} })[1]).toBe(
      "  codex mcp add broken -- ''",
    );
  });
});
