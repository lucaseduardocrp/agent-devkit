import { withPolicy } from '../core/guard.js';
import { mcpTokenEnv } from '../core/mcp.js';
import { parseJsonLines, tail } from '../core/text.js';
import { CliError, type CliAdapter, type CliOutput, type ProcessResult } from '../core/types.js';

/** OpenAI Codex CLI: `codex exec --json` prints one JSON event per line; the prompt comes on stdin. */
export const codexAdapter: CliAdapter = {
  id: 'codex',
  name: 'OpenAI Codex',
  supportsSessions: true,
  versionInvocation: { command: 'codex', args: ['--version'] },
  auth: {
    hint: 'Send an OpenAI API key, or the content of ~/.codex/auth.json after `codex login` on your computer (ChatGPT account).',
    classify(secret) {
      if (secret.startsWith('{')) {
        try {
          JSON.parse(secret);
        } catch {
          return null;
        }
        return { kind: 'file', path: '.codex/auth.json', content: secret };
      }
      return /^sk-/.test(secret) ? { kind: 'env', name: 'OPENAI_API_KEY', value: secret } : null;
    },
  },

  buildInvocation({ prompt, sessionId, autonomy, mcpServers }) {
    const args = ['exec'];
    if (sessionId) args.push('resume', sessionId);
    args.push('--json', '--skip-git-repo-check');
    args.push(
      ...(autonomy === 'auto'
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : ['--sandbox', 'read-only']),
    );
    // Codex reads each server's token from an environment variable, which only this user's process can see.
    const env: Record<string, string> = {};
    for (const server of mcpServers ?? []) {
      const variable = mcpTokenEnv(server.name);
      args.push(
        '-c',
        `mcp_servers.${server.name}.url=${JSON.stringify(server.url)}`,
        '-c',
        `mcp_servers.${server.name}.bearer_token_env_var=${JSON.stringify(variable)}`,
      );
      env[variable] = server.token;
    }
    args.push('-'); // the prompt follows on stdin
    return { command: 'codex', args, stdin: withPolicy(prompt), env };
  },

  parseOutput({ stdout, stderr, exitCode }: ProcessResult): CliOutput {
    const events = parseJsonLines(stdout);
    let sessionId: string | undefined;
    const messages: string[] = [];
    let failure = '';
    for (const event of events) {
      if (event.type === 'thread.started' && typeof event.thread_id === 'string')
        sessionId = event.thread_id;
      const item = event.item as { type?: unknown; text?: unknown } | undefined;
      if (event.type === 'item.completed' && item?.type === 'agent_message')
        messages.push(String(item.text ?? ''));
      if (event.type === 'turn.failed' || event.type === 'error') {
        const detail = (event.error as { message?: unknown } | undefined)?.message ?? event.message;
        failure = String(detail ?? 'The turn failed.');
      }
    }
    if (failure) throw new CliError(failure);
    if (exitCode !== 0)
      throw new CliError(tail(stderr) || tail(stdout) || `codex exited with ${exitCode}.`);
    // Without --json support (older versions) the answer is the plain stdout.
    const text = events.length ? messages.join('\n\n') : stdout;
    return { text: text.trim(), sessionId };
  },
};
