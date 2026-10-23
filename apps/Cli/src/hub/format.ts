import {
  skillSource,
  type HubIndex,
  type HubKind,
  type HubPlugin,
  type HubSkill,
} from './catalog.js';
import type { InstallRecord, McpServerConfig } from './install.js';

export type HubClient = 'claude' | 'codex' | 'agents';

const TIER_LABELS: Record<string, string> = {
  'built-in': 'built-in',
  official: 'official',
  verified: 'verified',
  community: 'community',
};

function truncate(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1).trimEnd()}…` : text;
}

function categoryLabel(index: HubIndex, kind: HubKind, id: string): string {
  const categories = kind === 'skill' ? index.categories.skills : index.categories.plugins;
  return categories.find((category) => category.id === id)?.label['en-US'] ?? id;
}

/** One line per item: name, tier, category and the start of the description. */
export function formatList(
  index: HubIndex,
  kind: HubKind,
  items: readonly (HubSkill | HubPlugin)[],
  installed: readonly InstallRecord[] = [],
): string {
  if (!items.length) return `No ${kind}s found in the ADK Hub.`;
  const width = Math.max(...items.map((item) => item.name.length));
  const lines = items.map((item) => {
    const mark = installed.some((record) => record.kind === kind && record.name === item.name)
      ? '✓'
      : ' ';
    const tier = TIER_LABELS[item.tier] ?? item.tier;
    return `${mark} ${item.name.padEnd(width)}  ${tier.padEnd(9)}  ${truncate(categoryLabel(index, kind, item.category), 16).padEnd(16)}  ${truncate(item.description, 70)}`;
  });
  return [
    ...lines,
    '',
    `${items.length} ${kind}${items.length === 1 ? '' : 's'}. Details: devkit ${kind}s info <name>. Install: devkit ${kind}s install <name>.`,
  ].join('\n');
}

/** Everything a user should read before installing. */
export function formatInfo(index: HubIndex, kind: HubKind, item: HubSkill | HubPlugin): string {
  const lines = [
    'title' in item && item.title !== item.name ? `${item.title} (${item.name})` : item.name,
    '',
    item.description,
    '',
    `Tier         ${TIER_LABELS[item.tier] ?? item.tier}`,
    `Category     ${categoryLabel(index, kind, item.category)}`,
    `License      ${item.license}`,
  ];
  if ('files' in item) {
    lines.push(`Author       ${item.author}`, `Version      ${item.version || '-'}`);
    if (item.tags.length) lines.push(`Tags         ${item.tags.join(', ')}`);
    if (item.toolsets.length) lines.push(`ADK tools    ${item.toolsets.join(', ')}`);
    const { repository, commit } = skillSource(index, item);
    lines.push(`Source       https://github.com/${repository}/tree/${commit}/${item.path}`);
  } else {
    const { skills, agents, mcpServers, requiresEnv } = item.capabilities;
    lines.push(
      `Maintainer   ${item.maintainer}`,
      `Version      ${item.version ? `${item.version} @ ${item.sha.slice(0, 12)}` : item.sha.slice(0, 12)}`,
      `Source       ${item.repo}${item.subdir ? ` (${item.subdir})` : ''}`,
      `Skills       ${skills.join(', ') || '-'}`,
      `Agents       ${agents.join(', ') || '-'}`,
      `MCP servers  ${mcpServers.join(', ') || '-'}`,
      `Needs env    ${requiresEnv.join(', ') || '-'}`,
    );
    if (item.platforms.length) lines.push(`Platforms    ${item.platforms.join(', ')}`);
    if (item.requiresDevkit) lines.push(`Needs devkit ${item.requiresDevkit}`);
    if (item.disclosure) lines.push('', `Disclosure: ${item.disclosure}`);
  }
  return lines.join('\n');
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Commands that register a plugin's MCP servers with the client; devkit never edits client settings. */
export function mcpInstructions(
  client: HubClient,
  scope: 'user' | 'project',
  servers: Readonly<Record<string, McpServerConfig>>,
): string[] {
  const entries = Object.entries(servers);
  if (!entries.length) return [];
  if (client === 'agents') {
    return [
      'Add these MCP servers to your client configuration:',
      JSON.stringify({ mcpServers: servers }, null, 2),
    ];
  }
  const commands = entries.map(([id, server]) => {
    if (client === 'claude') {
      const config = server.url
        ? {
            type: server.type ?? 'http',
            url: server.url,
            ...(server.headers ? { headers: server.headers } : {}),
          }
        : {
            type: 'stdio',
            command: server.command,
            args: server.args ?? [],
            env: server.env ?? {},
          };
      return `claude mcp add-json ${shellQuote(id)} ${shellQuote(JSON.stringify(config))} --scope ${scope}`;
    }
    if (server.url) return `codex mcp add ${shellQuote(id)} --url ${shellQuote(server.url)}`;
    const env = Object.entries(server.env ?? {}).map(
      ([key, value]) => ` --env ${shellQuote(`${key}=${value}`)}`,
    );
    const command = [server.command ?? '', ...(server.args ?? [])].map(shellQuote).join(' ');
    return `codex mcp add ${shellQuote(id)}${env.join('')} -- ${command}`;
  });
  return [
    'Register the MCP servers it needs with your assistant:',
    ...commands.map((command) => `  ${command}`),
  ];
}

export function formatInstalled(records: readonly InstallRecord[]): string {
  if (!records.length)
    return 'Nothing from the ADK Hub is installed. Browse with "devkit skills search".';
  return records
    .map(
      (record) =>
        `${record.kind.padEnd(6)}  ${record.name}  ${record.version || record.revision.slice(0, 12)}  → ${record.skillsDir}`,
    )
    .join('\n');
}
