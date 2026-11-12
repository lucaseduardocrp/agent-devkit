import { withPolicy } from '../core/guard.js';
import { tail } from '../core/text.js';
import { CliError, type CliAdapter, type CliOutput, type ProcessResult } from '../core/types.js';

/** Gemini CLI in non-interactive mode: the answer is the plain stdout. No conversation resume. */
export const geminiAdapter: CliAdapter = {
  id: 'gemini',
  name: 'Gemini CLI',
  supportsSessions: false,
  versionInvocation: { command: 'gemini', args: ['--version'] },
  auth: {
    hint: 'Send a Gemini API key (from Google AI Studio).',
    classify: (secret) =>
      /^[\w-]{20,}$/.test(secret) ? { kind: 'env', name: 'GEMINI_API_KEY', value: secret } : null,
  },

  // Gemini reads its MCP servers from settings.json in the HOME; keep the user's other settings.
  mcpFiles(servers) {
    return {
      '.gemini/settings.json': (current) => {
        let settings: Record<string, unknown> = {};
        try {
          const parsed: unknown = current ? JSON.parse(current) : {};
          if (parsed && typeof parsed === 'object') settings = parsed as Record<string, unknown>;
        } catch {
          // unreadable settings: start again rather than keep a broken file
        }
        settings.mcpServers = Object.fromEntries(
          servers.map((server) => [
            server.name,
            { httpUrl: server.url, headers: { Authorization: `Bearer ${server.token}` } },
          ]),
        );
        return JSON.stringify(settings, null, 2);
      },
    };
  },

  buildInvocation({ prompt, autonomy }) {
    const args = ['--prompt', withPolicy(prompt)];
    if (autonomy === 'auto') args.push('--yolo');
    return { command: 'gemini', args };
  },

  parseOutput({ stdout, stderr, exitCode }: ProcessResult): CliOutput {
    if (exitCode !== 0)
      throw new CliError(tail(stderr) || tail(stdout) || `gemini exited with ${exitCode}.`);
    return { text: stdout.trim() };
  },
};
