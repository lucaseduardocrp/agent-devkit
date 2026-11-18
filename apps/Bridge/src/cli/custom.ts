import { withPolicy } from '../core/guard.js';
import { tail } from '../core/text.js';
import { CliError, type CliAdapter } from '../core/types.js';

/**
 * Describes any CLI that takes a prompt and prints the answer, without writing code. Configured
 * in BRIDGE_CUSTOM_CLIS, e.g.
 *
 *   [{ "id": "antigravity", "name": "Antigravity", "command": "agy",
 *      "args": ["--print", "{prompt}"], "autoArgs": ["--yes"] }]
 *
 * `{prompt}` is replaced in `args`; when no argument has it the prompt goes to stdin.
 * `autoArgs` are added only in `auto` mode. Custom CLIs do not keep conversations.
 */
export interface CustomCliSpec {
  readonly id: string;
  readonly name?: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly autoArgs?: readonly string[];
  readonly versionArgs?: readonly string[];
  /** Environment variable that holds each user's key for this CLI, set with `/auth`. */
  readonly credentialEnv?: string;
}

const PLACEHOLDER = '{prompt}';

export function createCustomAdapter(spec: CustomCliSpec): CliAdapter {
  const args = spec.args ?? [];
  const usesPlaceholder = args.some((arg) => arg.includes(PLACEHOLDER));
  return {
    id: spec.id.toLowerCase(),
    name: spec.name ?? spec.id,
    supportsSessions: false,
    auth: spec.credentialEnv
      ? {
          hint: `Send the key for ${spec.name ?? spec.id}.`,
          classify: (secret) => ({ kind: 'env', name: spec.credentialEnv!, value: secret }),
        }
      : undefined,
    versionInvocation: { command: spec.command, args: spec.versionArgs ?? ['--version'] },
    buildInvocation({ prompt: request, autonomy }) {
      const prompt = withPolicy(request);
      const built = args.map((arg) => arg.split(PLACEHOLDER).join(prompt));
      if (autonomy === 'auto') built.push(...(spec.autoArgs ?? []));
      return {
        command: spec.command,
        args: built,
        stdin: usesPlaceholder ? undefined : prompt,
      };
    },
    parseOutput({ stdout, stderr, exitCode }) {
      if (exitCode !== 0)
        throw new CliError(
          tail(stderr) || tail(stdout) || `${spec.command} exited with ${exitCode}.`,
        );
      return { text: stdout.trim() };
    },
  };
}

/** Reads BRIDGE_CUSTOM_CLIS; throws a readable error for a malformed value. */
export function parseCustomClis(raw: string | undefined): CustomCliSpec[] {
  if (!raw?.trim()) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('BRIDGE_CUSTOM_CLIS must be a JSON array.');
  }
  if (!Array.isArray(value)) throw new Error('BRIDGE_CUSTOM_CLIS must be a JSON array.');
  return value.map((item, index) => {
    const spec = item as Partial<CustomCliSpec> | null;
    if (!spec || typeof spec.id !== 'string' || !/^[a-z0-9_-]+$/i.test(spec.id))
      throw new Error(`BRIDGE_CUSTOM_CLIS[${index}]: "id" must be letters, digits, "-" or "_".`);
    if (typeof spec.command !== 'string' || !spec.command)
      throw new Error(`BRIDGE_CUSTOM_CLIS[${index}]: "command" is required.`);
    return spec as CustomCliSpec;
  });
}
