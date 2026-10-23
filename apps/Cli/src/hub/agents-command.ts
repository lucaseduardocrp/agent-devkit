import {
  installHubAgent,
  listHubAgents,
  updateHubAgent,
  type AdkApi,
  type HubAgentCatalogDto,
} from '#mcp';

// `devkit agents …`: ADK Hub agents in the active ADK workspace. Unlike `devkit skills|plugins`,
// which install files on this computer, agents live in the workspace: the commands call the ADK
// API (as the Agents page and the agents_hub_* MCP tools do), which downloads and checks the files.

export interface AgentsCommandOptions {
  readonly plugin?: string;
  readonly json?: boolean;
}

export interface AgentsCommandContext {
  /** Human messages (stderr). */
  readonly say: (message: string) => void;
  /** Machine-readable output (stdout), used by --json. */
  readonly print: (message: string) => void;
  /** The API signed in with `devkit login`, created only when a command needs it. */
  readonly api: () => Promise<AdkApi>;
}

export const AGENT_ACTIONS = ['search', 'list', 'install', 'update'] as const;

type Row = {
  readonly id: string;
  readonly status: 'available' | 'installed' | 'update-available';
  readonly agentId?: string;
  readonly text: string;
};

const MARK = { available: ' ', installed: '✓', 'update-available': '↑' } as const;

/** Every installable agent, hub agents first, as `name` or `plugin/name`. */
function rowsOf(catalog: HubAgentCatalogDto): readonly Row[] {
  return [
    ...catalog.agents.map((agent) => ({
      id: agent.name,
      status: agent.status,
      ...(agent.installed ? { agentId: agent.installed.agentId } : {}),
      text: [
        agent.name,
        agent.role,
        agent.tier,
        agent.version,
        agent.description,
        agent.tags.join(' '),
      ].join(' '),
    })),
    ...catalog.plugins.flatMap((plugin) =>
      plugin.agents.map((agent) => ({
        id: `${plugin.name}/${agent.name}`,
        status: agent.status,
        ...(agent.installed ? { agentId: agent.installed.agentId } : {}),
        text: [plugin.name, agent.name, plugin.title, plugin.description].join(' '),
      })),
    ),
  ];
}

function formatCatalog(catalog: HubAgentCatalogDto, query: string): string {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => terms.every((term) => text.toLowerCase().includes(term));
  const agents = catalog.agents.filter((agent) =>
    matches([agent.name, agent.role, agent.description, agent.tags.join(' ')].join(' ')),
  );
  const plugins = catalog.plugins
    .map((plugin) => ({
      plugin,
      agents: plugin.agents.filter((agent) =>
        matches([plugin.name, plugin.title, plugin.description, agent.name].join(' ')),
      ),
    }))
    .filter((entry) => entry.agents.length);
  if (!agents.length && !plugins.length)
    return terms.length ? `No hub agent matches "${query}".` : 'The ADK Hub has no agents yet.';

  const width = Math.max(...agents.map((agent) => agent.name.length), 10);
  const lines: string[] = [];
  if (agents.length) {
    lines.push('Agents');
    for (const agent of agents) {
      const meta = `${agent.role.toLowerCase()} · ${agent.tier} · ${agent.version}`;
      lines.push(
        `  ${MARK[agent.status]} ${agent.name.padEnd(width)}  ${meta}`,
        `      ${agent.description}`,
      );
    }
  }
  for (const { plugin, agents: subagents } of plugins) {
    lines.push(
      '',
      `Plugin ${plugin.name} (${plugin.title}, ${plugin.maintainer} · ${plugin.tier} · ${plugin.version ?? plugin.sha.slice(0, 12)})`,
    );
    for (const agent of subagents) lines.push(`  ${MARK[agent.status]} ${agent.name}`);
  }
  lines.push(
    '',
    '✓ installed in the workspace   ↑ update available',
    'Install: devkit agents install <name>   ·   devkit agents install --plugin <plugin> [<name>]',
  );
  return lines.join('\n');
}

export async function runAgentsCommand(
  args: readonly string[],
  options: AgentsCommandOptions,
  context: AgentsCommandContext,
): Promise<void> {
  const [first, ...rest] = args;
  const action = first && (AGENT_ACTIONS as readonly string[]).includes(first) ? first : 'search';
  const names = action === 'search' && first !== 'search' ? args : rest;
  const { say, print } = context;
  const api = await context.api();

  switch (action) {
    case 'search':
    case 'list': {
      const catalog = await listHubAgents(api);
      if (options.json) return print(JSON.stringify(catalog, null, 2));
      return say(formatCatalog(catalog, names.join(' ')));
    }
    case 'install': {
      if (!names.length && !options.plugin) {
        throw new Error(
          'Usage: devkit agents install <name>... | devkit agents install --plugin <plugin> [<name>...]',
        );
      }
      const refs = names.length
        ? names.map((name) => ({ name, ...(options.plugin ? { plugin: options.plugin } : {}) }))
        : [{ plugin: options.plugin! }];
      const installed = [];
      for (const ref of refs) installed.push(...(await installHubAgent(api, ref)));
      if (options.json) return print(JSON.stringify(installed, null, 2));
      if (!installed.length) return say(`Every agent of ${options.plugin} is already installed.`);
      for (const agent of installed) {
        say(
          `Installed "${agent.name}" (${agent.source?.version ?? ''}) in the workspace. Find it on the Agents page.`,
        );
      }
      return;
    }
    case 'update': {
      const rows = rowsOf(await listHubAgents(api));
      const unknown = names.filter((name) => !rows.some((row) => row.id === name));
      if (unknown.length)
        throw new Error(
          `Not in the ADK Hub: ${unknown.join(', ')}. Use "devkit agents" to list them.`,
        );
      const notInstalled = names.filter(
        (name) => rows.find((row) => row.id === name)?.status === 'available',
      );
      if (notInstalled.length)
        throw new Error(`Not installed in this workspace: ${notInstalled.join(', ')}.`);
      const targets = rows.filter(
        (row) =>
          row.status === 'update-available' &&
          row.agentId &&
          (!names.length || names.includes(row.id)),
      );
      const updated = [];
      for (const row of targets) updated.push(await updateHubAgent(api, row.agentId!));
      if (options.json) return print(JSON.stringify(updated, null, 2));
      if (!updated.length) return say('Every agent installed from the ADK Hub is up to date.');
      for (const agent of updated)
        say(`Updated "${agent.name}" to ${agent.source?.version ?? 'the hub version'}.`);
      return;
    }
  }
}
