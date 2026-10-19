import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  installSkills,
  login,
  logout,
  signedInApi,
  storedApiUrl,
  skillTargetDirectory,
  whoami,
} from '../src/bootstrap/cli-commands.js';
import { loadConfig } from '../src/bootstrap/config.js';
import { packageVersion } from '../src/bootstrap/create-server.js';
import {
  loadSkills,
  packageRoot,
  parseFrontmatter,
  skillsDirectory,
} from '../src/bootstrap/skills.js';
import { ToolRegistry } from '../src/core/registry.js';
import { modules } from '../src/modules/index.js';

describe('packaged skills', () => {
  it('ships valid, uniquely named skills whose tool references exist', async () => {
    const skills = await loadSkills();
    expect(skills.map((skill) => skill.name)).toEqual([
      'adk-agents',
      'adk-brain',
      'adk-design',
      'adk-e2e',
      'adk-getting-started',
      'adk-release-notes',
      'adk-specs',
      'adk-test-plans',
      'adk-workspace-admin',
    ]);
    const tools = new Set(new ToolRegistry(modules).tools.map((tool) => tool.name));
    for (const skill of skills) {
      expect(skill.description.length, skill.name).toBeGreaterThan(40);
      expect(skill.path).toContain(join('skills', skill.name, 'SKILL.md'));
      const referenced = [...skill.content.matchAll(/`([a-z]+_[a-z_]+)(?:\s|`)/g)].map(
        (match) => match[1]!,
      );
      const unknown = referenced.filter(
        (name) => !tools.has(name) && !name.endsWith('_') && !['sourceType', 'x_y'].includes(name),
      );
      expect(unknown, `${skill.name} references unknown tools`).toEqual([]);
    }
  });

  it('parses frontmatter and tolerates missing folders or metadata', async () => {
    expect(parseFrontmatter('---\nname: "a"\ndescription: b: c\n---\n# x')).toEqual({
      name: 'a',
      description: 'b: c',
    });
    expect(parseFrontmatter('# none')).toEqual({});
    expect(await loadSkills(join(tmpdir(), 'does-not-exist-adk'))).toEqual([]);
    const dir = await mkdtemp(join(tmpdir(), 'adk-skills-'));
    await mkdir(join(dir, 'bare'));
    await writeFile(join(dir, 'bare', 'SKILL.md'), '# No frontmatter');
    await mkdir(join(dir, 'empty'));
    expect(await loadSkills(dir)).toMatchObject([{ name: 'bare', description: '' }]);
    expect(() => packageRoot(tmpdir().slice(0, 3))).toThrow('package root');
    expect(skillsDirectory()).toBe(join(packageRoot(), 'skills'));
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('CLI commands', () => {
  async function setup(tokensSupported = true) {
    const dir = await mkdtemp(join(tmpdir(), 'adk-cli-'));
    const config = loadConfig({
      ADK_API_URL: 'http://adk.test',
      ADK_MCP_SESSION_FILE: join(dir, 'session.json'),
    });
    const fetcher = vi.fn((url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path === '/auth/me')
        return Promise.resolve(Response.json({ user: { id: 'u1', email: 'a@b.c', name: 'Ana' } }));
      if (path === '/auth/login') {
        return Promise.resolve(
          Response.json({
            user: { id: 'u1', email: 'a@b.c', name: 'Ana' },
            token: 'pw-token',
            expiresAt: '2026-10-01',
          }),
        );
      }
      if (path === '/auth/tokens') {
        return Promise.resolve(
          tokensSupported
            ? Response.json(
                { token: 'adk_pat_new', accessToken: { expiresAt: '2026-12-24' } },
                { status: 201 },
              )
            : Response.json({ code: 'HTTP_404' }, { status: 404 }),
        );
      }
      if (path === '/auth/logout' && tokensSupported)
        return Promise.resolve(Response.json({ success: true }));
      return Promise.reject(new Error('offline'));
    }) as unknown as typeof fetch;
    return { dir, config, fetcher };
  }

  it('remembers the API of the last login for later commands', async () => {
    const { config, fetcher } = await setup();
    const env = { ADK_MCP_SESSION_FILE: config.sessionFile };
    expect(await storedApiUrl(env)).toBeUndefined();
    await login(config, { token: 'adk_pat_x' }, fetcher);
    expect(await storedApiUrl(env)).toBe('http://adk.test');
  });

  it('builds a signed-in API client for the local runner commands', async () => {
    const { config, fetcher } = await setup();
    await expect(signedInApi(config, 'devkit/test', fetcher)).rejects.toThrow('devkit login');
    await login(config, { token: 'adk_pat_x' }, fetcher);
    const { api, userName } = await signedInApi(config, 'devkit/test', fetcher);
    expect(userName).toBe('Ana');
    await api.request({ method: 'GET', path: '/auth/me' });
    const [, init] = vi.mocked(fetcher).mock.calls.at(-1)!;
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer adk_pat_x',
      'user-agent': 'devkit/test',
    });
  });

  it('logs in with a token or a password, shows and clears the session', async () => {
    const { config, fetcher } = await setup();
    expect(await login(config, { token: 'web-token' }, fetcher)).toMatchObject({
      user: { name: 'Ana' },
      kind: 'session',
    });
    expect((await login(config, { token: 'adk_pat_x' }, fetcher)).kind).toBe('access-token');
    expect(await whoami(config)).toMatchObject({
      authenticated: true,
      user: { name: 'Ana' },
      expiresAt: null,
    });

    const traded = await login(config, { email: 'a@b.c', password: 'secret' }, fetcher);
    expect(traded).toMatchObject({ kind: 'access-token', expiresAt: '2026-12-24' });
    const stored = JSON.parse(await readFile(config.sessionFile, 'utf8')) as { token: string };
    expect(stored.token).toBe('adk_pat_new');
    const tokenCall = vi
      .mocked(fetcher)
      .mock.calls.find(([url]) => String(url).endsWith('/auth/tokens'))!;
    expect(JSON.parse(String(tokenCall[1]!.body))).toMatchObject({
      scope: 'full',
      expiresInDays: 90,
    });
    expect(JSON.parse(String(tokenCall[1]!.body)).name).toMatch(/^devkit \(/);

    await logout(config, fetcher); // the revoke call fails offline but the local session is cleared
    expect(await whoami(config)).toMatchObject({
      authenticated: false,
      user: null,
      activeWorkspaceId: null,
    });
    await logout(config, fetcher);
    await expect(login(config, { email: 'a@b.c' }, fetcher)).rejects.toThrow('Provide --token');
  });

  it('keeps the session token when the API has no access tokens', async () => {
    const { config, fetcher } = await setup(false);
    const credential = await login(config, { email: 'a@b.c', password: 'secret' }, fetcher);
    expect(credential).toMatchObject({
      kind: 'session',
      token: 'pw-token',
      expiresAt: '2026-10-01',
    });
  });

  it('installs the skills into client folders', async () => {
    const { dir } = await setup();
    const result = await installSkills(join(dir, 'skills'));
    expect(result.installed).toContain('adk-test-plans');
    expect(await readFile(join(dir, 'skills', 'adk-test-plans', 'SKILL.md'), 'utf8')).toContain(
      'name: adk-test-plans',
    );

    expect(skillTargetDirectory('claude', 'user', '/repo', '/home/u')).toBe(
      join('/home/u', '.claude', 'skills'),
    );
    expect(skillTargetDirectory('codex', 'user', '/repo', '/home/u')).toBe(
      join('/home/u', '.codex', 'skills'),
    );
    expect(skillTargetDirectory('agents', 'project', '/repo', '/home/u')).toBe(
      join('/repo', '.agents', 'skills'),
    );
    expect(skillTargetDirectory('claude', 'project')).toBe(
      join(process.cwd(), '.claude', 'skills'),
    );
  });
});
