/**
 * An agent file: hub agents (AGENT.md) and plugin subagents (agents/<name>.md, the Claude Code
 * format) both start with a `key: value` front matter followed by the instructions. Only the
 * fields ADK uses are read; others (a subagent's `tools` or `model`) are ignored.
 */
export interface AgentMarkdown {
  readonly fields: Readonly<Record<string, string>>;
  /** Everything after the front matter: the agent's instructions. */
  readonly instructions: string;
  /** The first `# ` heading, used as the agent's display name. */
  readonly title?: string;
}

export function parseAgentMarkdown(text: string): AgentMarkdown {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  const fields: Record<string, string> = {};
  if (match) {
    for (const line of match[1]!.split(/\r?\n/)) {
      const separator = line.indexOf(':');
      if (/^\s/.test(line) || separator <= 0) continue;
      const value = line
        .slice(separator + 1)
        .trim()
        .replace(/^(["'])(.*)\1$/, '$2');
      fields[line.slice(0, separator).trim()] = value;
    }
  }
  const instructions = (match ? text.slice(match[0].length) : text).trim();
  const title = /^#\s+(.+?)\s*#*\s*$/m.exec(instructions)?.[1]?.trim();
  return { fields, instructions, ...(title ? { title } : {}) };
}
