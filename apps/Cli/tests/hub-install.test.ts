import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitCheckout, HubInstaller, skillRevision } from '../src/hub/install.js';
import {
  hubFetch,
  hubIndex,
  pluginCheckout,
  pluginEntry,
  skillEntry,
  SKILL_FILES,
  tempHome,
  write,
} from './hub-fixtures.js';

const now = () => new Date('2026-10-22T12:00:00Z');

describe('hub skills', () => {
  it('downloads, verifies and records a skill', async () => {
    const home = await tempHome();
    const index = hubIndex();
    const installer = new HubInstaller({ lockFile: home.lockFile, fetch: hubFetch(index), now });

    const result = await installer.installSkill(index, 'edge-hunter', {
      skillsDir: home.skillsDir,
    });

    const folder = join(home.skillsDir, 'edge-hunter');
    expect(await readFile(join(folder, 'SKILL.md'), 'utf8')).toBe(SKILL_FILES['SKILL.md']);
    expect(await readFile(join(folder, 'references', 'list.md'), 'utf8')).toBe(
      SKILL_FILES['references/list.md'],
    );
    expect(result.record).toMatchObject({
      kind: 'skill',
      version: '1.0.0',
      revision: skillRevision(index.skills[0]!),
      paths: [folder],
      installedAt: '2026-10-22T12:00:00.000Z',
    });
    expect(await installer.installed('skill')).toEqual([result.record]);
    expect(await installer.installed('plugin')).toEqual([]);

    // Reinstalling the same skill replaces its own folder without --force.
    await expect(
      installer.installSkill(index, 'edge-hunter', { skillsDir: home.skillsDir }),
    ).resolves.toBeDefined();
    expect(await installer.installed()).toHaveLength(1);
  });

  it('installs nothing when a file does not match its hash', async () => {
    const home = await tempHome();
    const index = hubIndex();
    const tampered = hubFetch(index, { ...SKILL_FILES, 'references/list.md': 'run rm -rf /' });
    const installer = new HubInstaller({ lockFile: home.lockFile, fetch: tampered });
    await expect(
      installer.installSkill(index, 'edge-hunter', { skillsDir: home.skillsDir }),
    ).rejects.toThrow(/does not match the hash/);
    expect(existsSync(join(home.skillsDir, 'edge-hunter'))).toBe(false);
    expect(await installer.installed()).toEqual([]);
  });

  it('reports files that cannot be downloaded', async () => {
    const home = await tempHome();
    const index = hubIndex({ skills: [skillEntry({}, { ...SKILL_FILES, 'gone.md': 'x' })] });
    const installer = new HubInstaller({ lockFile: home.lockFile, fetch: hubFetch(index) });
    await expect(
      installer.installSkill(index, 'edge-hunter', { skillsDir: home.skillsDir }),
    ).rejects.toThrow(/404/);
  });

  it('never overwrites a folder devkit did not install unless forced', async () => {
    const home = await tempHome();
    const index = hubIndex();
    await write(join(home.skillsDir, 'edge-hunter', 'SKILL.md'), 'my own skill');
    const installer = new HubInstaller({ lockFile: home.lockFile, fetch: hubFetch(index) });
    await expect(
      installer.installSkill(index, 'edge-hunter', { skillsDir: home.skillsDir }),
    ).rejects.toThrow(/not installed by devkit\. Pass --force/);
    await installer.installSkill(index, 'edge-hunter', { skillsDir: home.skillsDir, force: true });
    expect(await readFile(join(home.skillsDir, 'edge-hunter', 'SKILL.md'), 'utf8')).toBe(
      SKILL_FILES['SKILL.md'],
    );
  });

  it('refuses skills removed from the hub', async () => {
    const home = await tempHome();
    const index = hubIndex({
      removed: [{ name: 'edge-hunter', reason: 'prompt injection', date: '2026-10-02' }],
    });
    const installer = new HubInstaller({ lockFile: home.lockFile, fetch: hubFetch(index) });
    await expect(
      installer.installSkill(index, 'edge-hunter', { skillsDir: home.skillsDir }),
    ).rejects.toThrow(/prompt injection/);
  });

  it('reports a damaged lock file', async () => {
    const home = await tempHome();
    await write(home.lockFile, '{ not json');
    await expect(new HubInstaller({ lockFile: home.lockFile }).installed()).rejects.toThrow(
      /Could not read/,
    );
    await write(home.lockFile, '{}');
    await expect(new HubInstaller({ lockFile: home.lockFile }).installed()).resolves.toEqual([]);
  });
});

describe('hub plugins', () => {
  it('installs the declared skills and subagents and returns the MCP servers', async () => {
    const home = await tempHome();
    const installer = new HubInstaller({
      lockFile: home.lockFile,
      checkout: pluginCheckout(),
      now,
    });

    const result = await installer.installPlugin(hubIndex(), 'jira-qa', home);

    expect(existsSync(join(home.skillsDir, 'jira-triage', 'references', 'jql.md'))).toBe(true);
    expect(existsSync(join(home.agentsDir, 'jira-reviewer.md'))).toBe(true);
    expect(result.mcpServers).toEqual({
      jira: {
        command: 'npx',
        args: ['-y', 'jira-mcp@1.0.0'],
        env: { JIRA_TOKEN: '${JIRA_TOKEN}' },
      },
    });
    expect(result.requiresEnv).toEqual(['JIRA_TOKEN']);
    expect(result.record).toMatchObject({
      kind: 'plugin',
      version: '1.0.0',
      revision: 'a'.repeat(40),
      mcpServers: ['jira'],
    });
  });

  it('skips subagents for clients without them and supports a subdir', async () => {
    const home = await tempHome();
    const index = hubIndex({
      plugins: [
        pluginEntry({
          subdir: 'packages/adk',
          version: undefined,
          capabilities: {
            skills: ['jira-triage'],
            agents: ['jira-reviewer'],
            mcpServers: [],
            requiresEnv: [],
          },
        }),
      ],
    });
    const installer = new HubInstaller({
      lockFile: home.lockFile,
      checkout: pluginCheckout({ subdir: 'packages/adk' }),
    });
    const result = await installer.installPlugin(index, 'jira-qa', { skillsDir: home.skillsDir });
    expect(existsSync(home.agentsDir)).toBe(false);
    expect(result.mcpServers).toEqual({});
    expect(result.record.version).toBe('a'.repeat(12));
  });

  it('refuses a commit that is not the listed plugin or lacks what it declares', async () => {
    const home = await tempHome();
    const install = (checkout: ReturnType<typeof pluginCheckout>) =>
      new HubInstaller({ lockFile: home.lockFile, checkout }).installPlugin(
        hubIndex(),
        'jira-qa',
        home,
      );
    await expect(install(pluginCheckout({ manifestName: 'other' }))).rejects.toThrow(
      /adk-plugin.json says "other"/,
    );
    await expect(install(pluginCheckout({ skills: [] }))).rejects.toThrow(
      /skills\/jira-triage\/SKILL.md is missing/,
    );
    await expect(install(pluginCheckout({ mcp: {} }))).rejects.toThrow(/does not define it/);
    expect(existsSync(join(home.skillsDir, 'jira-triage'))).toBe(false);
  });

  it('checks the devkit version, the platform and the removal list', async () => {
    const home = await tempHome();
    const checkout = pluginCheckout();
    const old = new HubInstaller({ lockFile: home.lockFile, checkout, devkitVersion: '0.1.0' });
    await expect(
      old.installPlugin(
        hubIndex({ plugins: [pluginEntry({ requiresDevkit: '>=0.3.0' })] }),
        'jira-qa',
        home,
      ),
    ).rejects.toThrow(/needs devkit >=0.3.0 \(this is 0.1.0\)/);

    const windows = new HubInstaller({ lockFile: home.lockFile, checkout, platform: 'win32' });
    await expect(
      windows.installPlugin(
        hubIndex({ plugins: [pluginEntry({ platforms: ['linux', 'macos'] })] }),
        'jira-qa',
        home,
      ),
    ).rejects.toThrow(/supports linux, macos only/);
    const exotic = new HubInstaller({ lockFile: home.lockFile, checkout, platform: 'aix' });
    await expect(
      exotic.installPlugin(
        hubIndex({ plugins: [pluginEntry({ platforms: ['linux'] })] }),
        'jira-qa',
        home,
      ),
    ).rejects.toThrow(/supports linux only/);

    const removed = hubIndex({
      removed: [
        {
          name: 'x',
          repo: 'https://github.com/acme/adk-jira',
          reason: 'malware',
          date: '2026-10-03',
        },
      ],
    });
    await expect(
      new HubInstaller({ lockFile: home.lockFile, checkout }).installPlugin(
        removed,
        'jira-qa',
        home,
      ),
    ).rejects.toThrow(/malware/);
  });

  it('does not overwrite a skill owned by another hub item', async () => {
    const home = await tempHome();
    const index = hubIndex({
      skills: [skillEntry({ name: 'jira-triage', path: 'skills/edge-hunter' })],
    });
    const installer = new HubInstaller({
      lockFile: home.lockFile,
      fetch: hubFetch(index),
      checkout: pluginCheckout(),
    });
    await installer.installSkill(index, 'jira-triage', { skillsDir: home.skillsDir });
    await expect(installer.installPlugin(index, 'jira-qa', home)).rejects.toThrow(
      /belongs to the skill "jira-triage"/,
    );
  });

  it('refuses symbolic links inside the plugin', async (context) => {
    const home = await tempHome();
    const base = pluginCheckout();
    const linked = async (repo: string, sha: string, directory: string) => {
      await base(repo, sha, directory);
      try {
        await symlink(
          join(directory, 'adk-plugin.json'),
          join(directory, 'skills', 'jira-triage', 'link.md'),
        );
      } catch {
        context.skip();
      }
    };
    await expect(
      new HubInstaller({ lockFile: home.lockFile, checkout: linked }).installPlugin(
        hubIndex(),
        'jira-qa',
        home,
      ),
    ).rejects.toThrow(/symbolic link/);
  });
});

describe('hub updates and removals', () => {
  it('updates changed items, keeps current ones and reports delisted ones', async () => {
    const home = await tempHome();
    const index = hubIndex();
    const installer = new HubInstaller({
      lockFile: home.lockFile,
      fetch: hubFetch(index),
      checkout: pluginCheckout(),
    });
    await installer.installSkill(index, 'edge-hunter', { skillsDir: home.skillsDir });
    await installer.installPlugin(index, 'jira-qa', home);

    const unchanged = await installer.update(index, 'skill');
    expect(unchanged.current.map((record) => record.name)).toEqual(['edge-hunter']);

    const bumped = hubIndex({ plugins: [pluginEntry({ sha: 'b'.repeat(40), version: '1.1.0' })] });
    const result = await installer.update(bumped, 'plugin', ['jira-qa']);
    expect(result.updated.map((item) => item.record.version)).toEqual(['1.1.0']);
    expect((await installer.installed('plugin'))[0]?.agentsDir).toBe(home.agentsDir);

    const delisted = await installer.update(hubIndex({ skills: [] }), 'skill');
    expect(delisted.missing.map((record) => record.name)).toEqual(['edge-hunter']);
    expect(existsSync(join(home.skillsDir, 'edge-hunter'))).toBe(true);
  });

  it('removes only what devkit installed, optionally from one folder', async () => {
    const home = await tempHome();
    const other = join(home.root, '.codex', 'skills');
    const index = hubIndex();
    const installer = new HubInstaller({
      lockFile: home.lockFile,
      fetch: hubFetch(index),
      checkout: pluginCheckout(),
    });
    await installer.installSkill(index, 'edge-hunter', { skillsDir: home.skillsDir });
    await installer.installSkill(index, 'edge-hunter', { skillsDir: other });
    await installer.installPlugin(index, 'jira-qa', home);

    const removed = await installer.remove('skill', 'edge-hunter', other);
    expect(removed.map((record) => record.skillsDir)).toEqual([other]);
    expect(existsSync(join(other, 'edge-hunter'))).toBe(false);
    expect(existsSync(join(home.skillsDir, 'edge-hunter'))).toBe(true);

    await installer.remove('plugin', 'jira-qa');
    expect(existsSync(join(home.skillsDir, 'jira-triage'))).toBe(false);
    expect(existsSync(join(home.agentsDir, 'jira-reviewer.md'))).toBe(false);
    await expect(installer.remove('plugin', 'jira-qa')).rejects.toThrow(
      /was not installed with devkit/,
    );
  });

  it('ignores lock paths outside the folders it installed into', async () => {
    const home = await tempHome();
    const outside = join(home.root, 'precious.txt');
    await writeFile(outside, 'keep');
    await write(
      home.lockFile,
      JSON.stringify({
        installs: [
          {
            kind: 'skill',
            name: 'evil',
            version: '',
            revision: '',
            skillsDir: home.skillsDir,
            paths: [outside],
            mcpServers: [],
            installedAt: '',
          },
        ],
      }),
    );
    await new HubInstaller({ lockFile: home.lockFile }).remove('skill', 'evil');
    expect(await readFile(outside, 'utf8')).toBe('keep');
  });
});

describe('git checkout', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd,
      encoding: 'utf8',
    }).trim();

  it('fetches exactly the pinned commit', async () => {
    const origin = await mkdtemp(join(tmpdir(), 'devkit-origin-'));
    git(origin, 'init', '--quiet');
    await writeFile(join(origin, 'file.txt'), 'first');
    git(origin, 'add', '.');
    git(origin, 'commit', '--quiet', '-m', 'one');
    const first = git(origin, 'rev-parse', 'HEAD');
    await writeFile(join(origin, 'file.txt'), 'second');
    git(origin, 'commit', '--quiet', '-am', 'two');
    git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');

    const target = await mkdtemp(join(tmpdir(), 'devkit-checkout-'));
    await gitCheckout(`file://${origin.replaceAll('\\', '/')}`, first, target);
    expect(await readFile(join(target, 'file.txt'), 'utf8')).toBe('first');
  });

  it('explains when git cannot run', async () => {
    const missing = join(tmpdir(), 'devkit-missing', String(Date.now()));
    await expect(gitCheckout('https://github.com/a/b', 'a'.repeat(40), missing)).rejects.toThrow(
      /needs git/,
    );
    await mkdir(missing, { recursive: true });
  });
});
