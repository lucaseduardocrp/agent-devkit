import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryAgentRepository } from '../src/modules/agents/adapters/in-memory-agent-repository.js';
import { AgentService } from '../src/modules/agents/application/agent-service.js';
import { CustomAgent } from '../src/modules/agents/domain/agent-entity.js';
import { HttpHubCatalog } from '../src/modules/hub/adapters/http-hub-catalog.js';
import type { HubCatalog } from '../src/modules/hub/application/hub-catalog.js';
import { HubAgentService } from '../src/modules/hub/application/hub-agent-service.js';
import {
  agentFileOf,
  parseHubIndex,
  skillFileOf,
  type HubIndex,
} from '../src/modules/hub/domain/hub-index.js';

const WS = 'ws-hub';
const HUB = 'lucaseduardocrp/agent-devkit-hub';
const COMMIT = 'c'.repeat(40);
const SHA = 'a'.repeat(40);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const file = (path: string, text: string) => ({ path, size: text.length, sha256: sha256(text) });

const AGENT_MD = '---\nname: plain\nskills: [test-design, "edge-hunter"]\n---\n\nPlain agent.\n';
const SKILL_MD = '---\nname: test-design\n---\n\nWrite one test per criterion.\n';
const EDGE_MD = '---\nname: edge-hunter\n---\n\nList boundary values first.\n';

const skillEntry = (name: string, files = [file('SKILL.md', SKILL_MD)]) => ({
  name,
  description: `${name} description.`,
  category: 'qa',
  author: 'ADK',
  version: '1.0.0',
  license: 'MIT',
  tier: 'official',
  path: `skills/${name}`,
  files,
});

const plugin = (name: string, extra: object = {}) => ({
  name,
  title: name,
  description: `${name} plugin.`,
  repo: `https://github.com/acme/${name}`,
  sha: SHA,
  maintainer: 'acme',
  tier: 'community',
  category: 'general',
  license: 'MIT',
  capabilities: { agents: ['reviewer'] },
  ...extra,
});

function index(extra: object = {}): HubIndex {
  const parsed = parseHubIndex({
    schemaVersion: 1,
    repository: HUB,
    commit: COMMIT,
    generatedAt: 'now',
    categories: {},
    agents: [
      {
        name: 'plain',
        description: 'Plain agent.',
        category: 'qa',
        role: 'DOCUMENTATION',
        author: 'ADK',
        version: '2.0.0',
        license: 'MIT',
        tier: 'official',
        path: 'agents/plain',
        files: [file('AGENT.md', AGENT_MD)],
      },
    ],
    skills: [
      skillEntry('test-design'),
      skillEntry('edge-hunter', [file('SKILL.md', EDGE_MD)]),
      skillEntry('no-file', [file('README.md', 'x')]),
    ],
    plugins: [plugin('unversioned'), plugin('versioned', { version: '3.0.0' })],
    ...extra,
  });
  if (!parsed) throw new Error('fixture index is invalid');
  return parsed;
}

function fakeCatalog(
  hub: HubIndex,
  files: { agent?: string; plugin?: string; skills?: Record<string, string> } = {},
) {
  const catalog: HubCatalog = {
    index: vi.fn(async () => hub),
    agentFile: vi.fn(async () => files.agent ?? AGENT_MD),
    pluginAgentFile: vi.fn(async () => files.plugin ?? 'You review things.'),
    skillFile: vi.fn(
      async (_index, skill) =>
        files.skills?.[skill.name] ?? (skill.name === 'edge-hunter' ? EDGE_MD : SKILL_MD),
    ),
  };
  return catalog;
}

function setup(hub = index(), files?: Parameters<typeof fakeCatalog>[1]) {
  const repository = new InMemoryAgentRepository();
  const agents = new AgentService({ agentRepository: repository });
  const catalog = fakeCatalog(hub, files);
  return { repository, agents, catalog, service: new HubAgentService(catalog, agents) };
}

describe('HubAgentService', () => {
  it('lists plugins without a version and hides skills without SKILL.md', async () => {
    const { service } = setup();
    const catalog = await service.catalog(WS);
    expect(catalog.plugins.map((item) => [item.name, item.version])).toEqual([
      ['unversioned', undefined],
      ['versioned', '3.0.0'],
    ]);
    expect(catalog.plugins[0]).not.toHaveProperty('version');
    expect(catalog.skills.map((skill) => skill.name)).toEqual(['test-design', 'edge-hunter']);
  });

  it('installs a hub agent with the skills its file asks for and without a heading', async () => {
    const { service } = setup();
    const [agent] = await service.install(WS, { name: 'plain' });
    expect(agent).toMatchObject({ name: 'plain', role: 'DOCUMENTATION', temperature: 0.2 });
    expect(agent!.skills.map((skill) => skill.name)).toEqual(['test-design', 'edge-hunter']);
  });

  it('refuses unknown agents, plugins and plugin subagents', async () => {
    const { service } = setup();
    await expect(service.install(WS, {})).rejects.toMatchObject({ code: 'HUB_AGENT_NOT_FOUND' });
    await expect(service.install(WS, { plugin: 'missing' })).rejects.toMatchObject({
      code: 'HUB_AGENT_NOT_FOUND',
    });
    await expect(service.install(WS, { plugin: 'versioned', name: 'other' })).rejects.toThrow(
      "'versioned/other' is not in the ADK Hub.",
    );
  });

  it('installs one subagent of a plugin, with fallbacks for its name and description', async () => {
    const { service } = setup();
    const [agent] = await service.install(WS, { plugin: 'unversioned', name: 'reviewer' });
    expect(agent).toMatchObject({
      name: 'reviewer',
      description: 'unversioned plugin.',
      role: 'CUSTOM',
      source: {
        kind: 'hub-plugin',
        name: 'reviewer',
        plugin: 'unversioned',
        version: SHA.slice(0, 12),
        revision: SHA,
      },
    });
    await expect(
      service.install(WS, { plugin: 'unversioned', name: 'reviewer' }),
    ).rejects.toMatchObject({ code: 'HUB_AGENT_INSTALLED', statusCode: 409 });
  });

  it('refuses more than ten skills and unknown skills', async () => {
    const { service } = setup();
    const names = Array.from({ length: 11 }, (_, i) => `skill-${i}`);
    await expect(service.resolveSkills(names)).rejects.toMatchObject({
      code: 'AGENT_TOO_MANY_SKILLS',
      statusCode: 400,
    });
    await expect(service.resolveSkills(['no-file'])).rejects.toMatchObject({
      code: 'HUB_SKILL_NOT_FOUND',
    });
  });

  it('refuses empty and oversized skills', async () => {
    await expect(
      setup(index(), { skills: { 'test-design': '---\nname: x\n---\n' } }).service.resolveSkills([
        'test-design',
      ]),
    ).rejects.toMatchObject({ code: 'HUB_FILE_MISMATCH', statusCode: 502 });
    await expect(
      setup(index(), { skills: { 'test-design': 'x'.repeat(64_001) } }).service.resolveSkills([
        'test-design',
      ]),
    ).rejects.toMatchObject({ code: 'HUB_SKILL_TOO_LARGE', statusCode: 400 });
  });

  it('updates a hub agent, refreshing its skills and dropping removed ones', async () => {
    const { service, repository } = setup(
      index({ removed: [{ name: 'edge-hunter', reason: 'unsafe' }] }),
    );
    const old = (name: string) => ({
      name,
      description: 'old',
      instructions: 'Old copy.',
      version: '0.1.0',
      revision: 'old',
    });
    await repository.save(
      new CustomAgent({
        id: 'a1',
        workspaceId: WS,
        name: 'Old',
        slug: 'plain',
        description: '',
        role: 'QA',
        instructions: 'Old instructions.',
        source: { kind: 'hub-agent', name: 'plain', version: '1.0.0', revision: 'old' },
        skills: [old('test-design'), old('edge-hunter')],
      }),
    );

    const updated = await service.update(WS, 'a1');

    expect(updated).toMatchObject({
      name: 'plain',
      role: 'QA',
      instructions: 'Plain agent.',
      source: { kind: 'hub-agent', version: '2.0.0' },
    });
    expect(updated.skills).toEqual([
      {
        name: 'test-design',
        description: 'test-design description.',
        instructions: 'Write one test per criterion.',
        version: '1.0.0',
        revision: sha256(SKILL_MD),
      },
    ]);
  });

  it('updates plugin subagents only while the plugin still lists them', async () => {
    const { service, repository } = setup(index(), {
      plugin: '---\nname: Reviewer Bot\ndescription: Reviews.\n---\n\nReview carefully.\n',
    });
    const agent = (id: string, source: object) =>
      repository.save(
        new CustomAgent({
          id,
          workspaceId: WS,
          name: id,
          slug: id,
          description: '',
          role: 'CUSTOM',
          instructions: 'Old.',
          source: source as never,
        }),
      );
    await agent('listed', {
      kind: 'hub-plugin',
      name: 'reviewer',
      plugin: 'versioned',
      version: '1',
      revision: 'old',
    });
    await agent('unlisted', {
      kind: 'hub-plugin',
      name: 'gone',
      plugin: 'versioned',
      version: '1',
      revision: 'old',
    });
    await agent('pluginless', { kind: 'hub-plugin', name: 'reviewer', version: '1' });

    await expect(service.update(WS, 'listed')).resolves.toMatchObject({
      name: 'Reviewer Bot',
      description: 'Reviews.',
      instructions: 'Review carefully.',
      source: { version: '3.0.0', revision: SHA },
    });
    await expect(service.update(WS, 'unlisted')).rejects.toThrow(
      "'versioned/gone' is not in the ADK Hub.",
    );
    await expect(service.update(WS, 'pluginless')).rejects.toThrow("'' is not in the ADK Hub.");
  });
});

describe('hub index helpers', () => {
  it('rejects unreadable indexes and finds instruction files', () => {
    expect(parseHubIndex({ schemaVersion: 2 })).toBeNull();
    const hub = index();
    expect(skillFileOf(hub.skills[2]!)).toBeNull();
    const agent = { ...hub.agents[0]!, files: [file('README.md', 'x')] };
    expect(agentFileOf(agent).path).toBe('README.md');
  });
});

describe('HttpHubCatalog', () => {
  const hubJson = () => JSON.parse(JSON.stringify(index())) as HubIndex;

  function fetcher(routes: Record<string, () => Response | Promise<Response>>) {
    return vi.fn(async (input: string | URL | Request) => {
      const route = routes[String(input)];
      return route ? route() : new Response('missing', { status: 404 });
    }) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
  }

  it('sends the GitHub token when asking for the newest commit', async () => {
    const fetch = fetcher({
      [`https://api.github.com/repos/${HUB}/commits/main`]: () => new Response(COMMIT),
      [`https://raw.githubusercontent.com/${HUB}/${COMMIT}/index.json`]: () =>
        Response.json(hubJson()),
    });
    const catalog = new HttpHubCatalog({ fetch, githubToken: 'tok', ttlMs: 0 });
    await expect(catalog.index()).resolves.toMatchObject({ commit: COMMIT });
    expect(fetch.mock.calls[0]![1]).toMatchObject({
      headers: { authorization: 'Bearer tok', accept: 'application/vnd.github.sha' },
    });
  });

  it('refuses indexes it cannot read and reports non-Error failures', async () => {
    const unreadable = new HttpHubCatalog({
      indexUrl: 'https://mirror.test/index.json',
      fetch: fetcher({
        'https://mirror.test/index.json': () => Response.json({ schemaVersion: 9 }),
      }),
    });
    await expect(unreadable.index()).rejects.toThrow(
      'https://mirror.test/index.json is not an index this ADK can read.',
    );

    const odd = new HttpHubCatalog({
      indexUrl: 'https://mirror.test/index.json',
      fetch: vi.fn(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'boom';
      }) as unknown as typeof fetch,
    });
    await expect(odd.index()).rejects.toMatchObject({ code: 'HUB_UNAVAILABLE' });
  });

  it('maps missing, failing and oversized files to errors', async () => {
    const hub = index();
    const base = `https://raw.githubusercontent.com/${HUB}/${COMMIT}`;
    const catalog = new HttpHubCatalog({
      fetch: fetcher({
        [`${base}/agents/plain/AGENT.md`]: () => new Response('down', { status: 500 }),
        [`${base}/skills/test-design/SKILL.md`]: () => new Response('x'.repeat(256 * 1024 + 1)),
      }),
    });

    await expect(catalog.agentFile(hub, hub.agents[0]!)).rejects.toMatchObject({
      code: 'HUB_UNAVAILABLE',
      statusCode: 503,
    });
    await expect(catalog.skillFile(hub, hub.skills[0]!)).rejects.toMatchObject({
      code: 'HUB_FILE_MISMATCH',
      statusCode: 502,
    });
    await expect(catalog.skillFile(hub, hub.skills[1]!)).rejects.toMatchObject({
      code: 'HUB_AGENT_NOT_FOUND',
      statusCode: 404,
    });
    await expect(catalog.skillFile(hub, hub.skills[2]!)).rejects.toThrow(
      'skills/no-file has no SKILL.md.',
    );
  });
});
