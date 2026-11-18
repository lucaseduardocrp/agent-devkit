import { join } from 'node:path';
import { PROTECTED_PATHS, SECURITY_POLICY } from '../core/guard.js';
import { tail } from '../core/text.js';
import { CliError, type CliAdapter, type CliOutput, type ProcessResult } from '../core/types.js';

const MCP_FILE = '.adk/mcp-claude.json';

/** Claude Code in print mode: `claude -p` reads the prompt from stdin and prints one JSON result. */
export const claudeAdapter: CliAdapter = {
  id: 'claude',
  name: 'Claude Code',
  supportsSessions: true,
  versionInvocation: { command: 'claude', args: ['--version'] },
  auth: {
    hint: 'Run `claude setup-token` on your computer (Claude subscription) and send the token, or send an Anthropic API key.',
    classify(secret) {
      if (/^sk-ant-oat/.test(secret))
        return { kind: 'env', name: 'CLAUDE_CODE_OAUTH_TOKEN', value: secret };
      if (/^sk-ant-/.test(secret)) return { kind: 'env', name: 'ANTHROPIC_API_KEY', value: secret };
      return null;
    },
  },

  // The config holds the token, so it is a 0600 file in the user's HOME, not a command-line flag.
  mcpFiles(servers) {
    return {
      [MCP_FILE]: () =>
        JSON.stringify({
          mcpServers: Object.fromEntries(
            servers.map((server) => [
              server.name,
              {
                type: 'http',
                url: server.url,
                headers: { Authorization: `Bearer ${server.token}` },
              },
            ]),
          ),
        }),
    };
  },

  buildInvocation({ prompt, sessionId, autonomy, home, mcpServers }) {
    const args = ['-p', '--output-format', 'json'];
    if (sessionId) args.push('--resume', sessionId);
    // The container is the sandbox: `auto` skips the permission prompts nobody could answer.
    if (autonomy === 'auto') args.push('--dangerously-skip-permissions');
    else args.push('--allowedTools', 'Read,Grep,Glob,LS');
    if (home && mcpServers?.length) args.push('--mcp-config', join(home, MCP_FILE));
    // Standing rules against prompt injection, as a system prompt (not something a file can edit).
    args.push('--append-system-prompt', SECURITY_POLICY);
    // Nothing reads the CLI's logins and settings, and nothing writes to them (a planted hook
    // would run on every later message).
    args.push(
      '--disallowedTools',
      ['Read', 'Edit', 'Write']
        .flatMap((tool) => PROTECTED_PATHS.map((path) => `${tool}(${path})`))
        .join(','),
    );
    // Claude strips its own credentials from the environment of the commands it runs.
    return {
      command: 'claude',
      args,
      stdin: prompt,
      env: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' },
    };
  },

  parseOutput({ stdout, stderr, exitCode }: ProcessResult): CliOutput {
    const payload = parseResult(stdout);
    if (payload?.is_error || (exitCode !== 0 && !payload)) {
      throw new CliError(
        asText(payload?.result) ||
          tail(stderr) ||
          tail(stdout) ||
          `claude exited with ${exitCode}.`,
      );
    }
    if (!payload) throw new CliError(`Unexpected output from claude: ${tail(stdout)}`);
    const sessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined;
    return { text: asText(payload.result), sessionId };
  },
};

function parseResult(stdout: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stdout);
    // `--verbose` turns the result into the last item of an array of events.
    const result = Array.isArray(value)
      ? value.findLast((item) => (item as { type?: unknown })?.type === 'result')
      : value;
    return result && typeof result === 'object' ? (result as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
