// This file has no imports on purpose: apps/Bridge keeps a verbatim copy
// (scripts/sync-cli-specs.mjs there), so what an AI CLI is asked, and how its output is read,
// lives in one place. Run that script after changing it; the Bridge's parity test fails otherwise.

/** An MCP server the CLI may use during the run, with the token that signs it in. */
export interface CliMcpServer {
  readonly name: string;
  readonly url: string;
  readonly token: string;
}

/** An image handed to the CLI, as base64. */
export interface CliImage {
  readonly mimeType: string;
  readonly data: string;
}

/** A file handed to the CLI, as base64. `name` is only shown to the model, never used as a path. */
export interface CliFile {
  readonly name: string;
  readonly mimeType: string;
  readonly data: string;
}

/** What a CLI is asked: the part of an LLM request that a command line can carry. */
export interface CliPrompt {
  readonly prompt: string;
  readonly instruction?: string;
  readonly mcp?: CliMcpServer;
  readonly images?: readonly CliImage[];
  readonly files?: readonly CliFile[];
}

const MCP_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const MCP_URL = /^https?:\/\/[A-Za-z0-9._:/?&=~+-]{1,300}$/;

/**
 * An MCP server ends up in a config file or on a command line, so what identifies it is checked
 * here, once, whoever calls. The token never goes on a command line.
 */
export function isValidMcpServer(server: CliMcpServer): boolean {
  return MCP_NAME.test(server.name) && MCP_URL.test(server.url) && server.token.length > 0;
}

/** The environment variable a CLI reads the MCP token from, when it cannot take it in a file. */
const MCP_TOKEN_ENV = 'ADK_MCP_TOKEN';

export type CliId = 'claude' | 'codex' | 'gemini';

/** What a CLI produced, in the order it produced it. */
export type CliEvent =
  | { readonly type: 'delta'; readonly text: string }
  /** The complete answer; only used when the CLI sent no `delta` before. */
  | { readonly type: 'final'; readonly text: string }
  | {
      readonly type: 'usage';
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly model?: string;
    }
  | { readonly type: 'error'; readonly message: string };

export interface CliInvocation {
  readonly args: readonly string[];
  readonly stdin: string;
  /** Files created in the CLI's empty working directory, by name: text, or `{ base64 }` bytes. */
  readonly files: Readonly<Record<string, string | { readonly base64: string }>>;
  /** Variables for this run only: where a secret goes when it cannot go on the command line. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface CliSpec {
  readonly id: CliId;
  readonly label: string;
  readonly command: string;
  readonly versionArgs: readonly string[];
  /** `true` when stdout is JSONL; `false` when it is the answer's plain text. */
  readonly jsonLines: boolean;
  readonly supportsImages: boolean;
  /**
   * How a file of this media type reaches the model: `text` is read into the prompt, `native` is
   * handed over as a document the CLI understands (a PDF), `null` is not something it can read.
   */
  readonly fileSupport: (mimeType: string) => 'text' | 'native' | null;
  /**
   * How the CLI is given the ADK's MCP server: `inline` is part of the run itself (`build` takes
   * care of it); `home` is a file in the user's HOME, which only a host that owns that HOME (the
   * Bridge) may write, so a CLI run on the API's own machine does not get it.
   */
  readonly mcp: 'inline' | 'home';
  readonly build: (request: CliPrompt, model: string | undefined) => CliInvocation;
  /** A fresh parser per run: it keeps whatever state it needs between lines. */
  readonly createParser: () => (chunk: string) => CliEvent[];
}

/** Model ids are the only free-form value on a command line, so they are strictly shaped. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,99}$/;

export function isValidModelId(model: string): boolean {
  return MODEL_ID.test(model);
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value && typeof value === 'object' ? (value as Json) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

function parseJson(line: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === 'object' ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

/** The instruction travels with the prompt for CLIs that have no system-prompt option. */
function withInstruction(request: CliPrompt): string {
  const instruction = request.instruction?.trim();
  return instruction ? `${instruction}\n\n---\n\n${request.prompt}` : request.prompt;
}

const IMAGE_EXTENSION: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Text a model reads as text, whatever the file is called. */
const isTextType = (mimeType: string): boolean =>
  mimeType.startsWith('text/') || /^application\/(json|xml|yaml|x-yaml)$/.test(mimeType);

const textOrPdf = (mimeType: string): 'text' | 'native' | null =>
  isTextType(mimeType) ? 'text' : mimeType === 'application/pdf' ? 'native' : null;

/** An inlined file is part of the prompt, so a very large one is cut instead of filling the context. */
const MAX_INLINE_CHARS = 400_000;

/** A name made safe to read in a prompt: one line, no quotes, no control characters. */
function displayName(name: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f"`]/g, ' ').trim();
  return clean.slice(0, 120) || fallback;
}

/**
 * Why a CLI cannot be given these images, or `undefined` when it can. Files are never a reason to
 * refuse: one the CLI cannot read is left out of the prompt, and said so there.
 */
export function attachmentProblem(spec: CliSpec, request: CliPrompt): string | undefined {
  const images = request.images ?? [];
  if (images.length > 0 && !spec.supportsImages) return `${spec.label} CLI does not accept images.`;
  for (const image of images) {
    if (!IMAGE_EXTENSION[image.mimeType])
      return `${spec.label} CLI cannot read ${image.mimeType} images.`;
  }
  return undefined;
}

/** Images as they are named in the CLI's working directory (`image-1.png`, …). */
function imageFiles(request: CliPrompt): Array<{ name: string; data: string }> {
  return (request.images ?? []).map((image, index) => ({
    name: `image-${index + 1}.${IMAGE_EXTENSION[image.mimeType] ?? 'png'}`,
    data: image.data,
  }));
}

/** The PDFs, which a CLI takes as documents, named for its working directory (`file-1.pdf`, …). */
function documentFiles(
  request: CliPrompt,
  spec: CliSpec,
): Array<{ name: string; title: string; data: string }> {
  const documents: Array<{ name: string; title: string; data: string }> = [];
  for (const [index, file] of (request.files ?? []).entries()) {
    if (spec.fileSupport(file.mimeType) !== 'native') continue;
    documents.push({
      name: `file-${documents.length + 1}.pdf`,
      title: displayName(file.name, `file ${index + 1}`),
      data: file.data,
    });
  }
  return documents;
}

/** What a model that only reads text can do with a file: read it as text, or not at all. */
export const textOnlyFiles = (mimeType: string): 'text' | null =>
  isTextType(mimeType) ? 'text' : null;

/**
 * The prompt, followed by every file that is read as text. A file the reader cannot take at all is
 * named, so the model knows it exists instead of answering as if nobody had attached it; the
 * ones handed over as documents (`native`) are the reader's business.
 */
export function withFiles(
  prompt: string,
  files: readonly CliFile[],
  support: (mimeType: string) => 'text' | 'native' | null,
): string {
  const blocks: string[] = [];
  const left: string[] = [];
  for (const [index, file] of files.entries()) {
    const how = support(file.mimeType);
    const name = displayName(file.name, `file ${index + 1}`);
    if (how === null) left.push(`"${name}" (${file.mimeType})`);
    if (how !== 'text') continue;
    let content = Buffer.from(file.data, 'base64').toString('utf8');
    const cut = content.length > MAX_INLINE_CHARS;
    if (cut) content = content.slice(0, MAX_INLINE_CHARS);
    // A fence longer than any run of backticks inside, so the content cannot close it early.
    const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((run) => run[0].length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    const note = cut ? '\n[cut: file too long]' : '';
    blocks.push(`Attached file "${name}":\n${fence}\n${content}${note}\n${fence}`);
  }
  if (left.length)
    blocks.push(`Attached files that could not be read and are left out: ${left.join(', ')}.`);
  return blocks.length ? `${prompt}\n\n${blocks.join('\n\n')}` : prompt;
}

function withTextFiles(prompt: string, request: CliPrompt, spec: CliSpec): string {
  return withFiles(prompt, request.files ?? [], spec.fileSupport);
}

/**
 * Claude Code, `-p --output-format stream-json --include-partial-messages`.
 *
 * Isolated on purpose: `--tools ""` removes every built-in tool, `--strict-mcp-config` drops the
 * user's MCP servers and connectors, `--setting-sources ""` ignores user and project settings
 * (hooks, memory) and `--system-prompt-file` replaces Claude Code's own agent prompt. What is left
 * is a plain completion that streams text deltas.
 *
 * Given the ADK's MCP server it adds exactly that one (`--mcp-config`, the token in a file) and
 * allows only its tools: the built-in ones stay off.
 */
const claude: CliSpec = {
  id: 'claude',
  label: 'Claude',
  command: 'claude',
  versionArgs: ['--version'],
  jsonLines: true,
  supportsImages: true,
  fileSupport: textOrPdf,
  mcp: 'inline',
  build(request, model) {
    const mcp = request.mcp && isValidMcpServer(request.mcp) ? request.mcp : undefined;
    const images = imageFiles(request);
    const documents = documentFiles(request, claude);
    const prompt = withTextFiles(request.prompt, request, claude);
    // Images and PDFs only travel as content blocks, which `stream-json` input carries: one user
    // message on stdin. A plain prompt keeps the simple text input.
    const blocks = images.length + documents.length > 0;
    const message = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          ...(request.images ?? []).map((image) => ({
            type: 'image',
            source: { type: 'base64', media_type: image.mimeType, data: image.data },
          })),
          ...documents.map((document) => ({
            type: 'document',
            title: document.title,
            source: { type: 'base64', media_type: 'application/pdf', data: document.data },
          })),
          { type: 'text', text: prompt },
        ],
      },
    });
    return {
      args: [
        '-p',
        ...(blocks ? ['--input-format', 'stream-json'] : []),
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--no-session-persistence',
        '--tools',
        '',
        '--strict-mcp-config',
        ...(mcp ? ['--mcp-config', 'mcp.json', '--allowedTools', `mcp__${mcp.name}`] : []),
        '--setting-sources',
        '',
        '--system-prompt-file',
        'system.txt',
        ...(model ? ['--model', model] : []),
      ],
      stdin: blocks ? `${message}\n` : prompt,
      files: {
        'system.txt': request.instruction?.trim() || 'You are a helpful assistant.',
        ...(mcp
          ? {
              'mcp.json': JSON.stringify({
                mcpServers: {
                  [mcp.name]: {
                    type: 'http',
                    url: mcp.url,
                    headers: { Authorization: `Bearer ${mcp.token}` },
                  },
                },
              }),
            }
          : {}),
      },
    };
  },
  createParser() {
    let model: string | undefined;
    return (line) => {
      const event = parseJson(line);
      if (!event) return [];
      const type = text(event['type']);
      if (type === 'stream_event') {
        const inner = record(event['event']);
        if (inner['type'] === 'message_start') {
          model = text(record(inner['message'])['model']) || model;
        } else if (inner['type'] === 'content_block_delta' && !event['parent_tool_use_id']) {
          const delta = record(inner['delta']);
          if (delta['type'] === 'text_delta' && text(delta['text']))
            return [{ type: 'delta', text: text(delta['text']) }];
        }
        return [];
      }
      if (type === 'result') {
        const result = text(event['result']);
        if (event['is_error'] === true || (event['subtype'] && event['subtype'] !== 'success'))
          return [
            {
              type: 'error',
              message: result || text(event['subtype']) || 'Claude reported an error.',
            },
          ];
        const usage = record(event['usage']);
        return [
          { type: 'final', text: result },
          {
            type: 'usage',
            inputTokens:
              count(usage['input_tokens']) +
              count(usage['cache_creation_input_tokens']) +
              count(usage['cache_read_input_tokens']),
            outputTokens: count(usage['output_tokens']),
            ...(model ? { model } : {}),
          },
        ];
      }
      return [];
    };
  },
};

/**
 * Codex, `exec --json`. Codex reports whole messages, not token deltas, so each message arrives
 * at once. It has no system-prompt option, so the instruction is placed before the prompt.
 */
const codex: CliSpec = {
  id: 'codex',
  label: 'Codex',
  command: 'codex',
  versionArgs: ['--version'],
  jsonLines: true,
  supportsImages: true,
  // Codex reads text, and takes images as files; it has no way to be handed a PDF.
  fileSupport: textOnlyFiles,
  mcp: 'inline',
  build(request, model) {
    const mcp = request.mcp && isValidMcpServer(request.mcp) ? request.mcp : undefined;
    const images = imageFiles(request);
    return {
      args: [
        'exec',
        // `--image` takes every value up to the next flag, so it comes before one (never last).
        ...(images.length ? [`--image=${images.map((image) => image.name).join(',')}`] : []),
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        ...(model ? ['--model', model] : []),
        // The server goes in as config overrides; the token only as an environment variable.
        ...(mcp
          ? [
              '-c',
              `mcp_servers.${mcp.name}.url=${mcp.url}`,
              '-c',
              `mcp_servers.${mcp.name}.bearer_token_env_var=${MCP_TOKEN_ENV}`,
            ]
          : []),
        '-',
      ],
      stdin: withTextFiles(withInstruction(request), request, codex),
      files: Object.fromEntries(images.map((image) => [image.name, { base64: image.data }])),
      ...(mcp ? { env: { [MCP_TOKEN_ENV]: mcp.token } } : {}),
    };
  },
  createParser() {
    let messages = 0;
    return (line) => {
      const event = parseJson(line);
      if (!event) return [];
      const type = text(event['type']);
      if (type === 'item.completed') {
        const item = record(event['item']);
        if (item['type'] === 'agent_message' && text(item['text'])) {
          const separator = messages++ > 0 ? '\n\n' : '';
          return [{ type: 'delta', text: separator + text(item['text']) }];
        }
      } else if (type === 'turn.completed') {
        const usage = record(event['usage']);
        return [
          {
            type: 'usage',
            inputTokens: count(usage['input_tokens']),
            outputTokens: count(usage['output_tokens']),
          },
        ];
      } else if (type === 'turn.failed' || type === 'error') {
        return [
          {
            type: 'error',
            message:
              text(record(event['error'])['message']) || text(event['message']) || 'Codex failed.',
          },
        ];
      }
      return [];
    };
  },
};

/** Gemini CLI prints the answer as plain text, so every stdout chunk is a delta. */
const gemini: CliSpec = {
  id: 'gemini',
  label: 'Gemini',
  command: 'gemini',
  versionArgs: ['--version'],
  jsonLines: false,
  supportsImages: true,
  fileSupport: textOrPdf,
  mcp: 'home',
  build(request, model) {
    // Gemini reads what a prompt points at with `@file`; the files sit in its working directory.
    const media = [...imageFiles(request), ...documentFiles(request, gemini)];
    const prompt = withTextFiles(withInstruction(request), request, gemini);
    return {
      args: model ? ['--model', model] : [],
      stdin: media.length
        ? `${media.map((file) => `@${file.name}`).join(' ')}\n\n${prompt}`
        : prompt,
      files: Object.fromEntries(media.map((file) => [file.name, { base64: file.data }])),
    };
  },
  createParser() {
    return (chunk) => (chunk ? [{ type: 'delta', text: chunk }] : []);
  },
};

export const CLI_SPECS: Readonly<Record<CliId, CliSpec>> = { claude, codex, gemini };

/** Which provider CLI replaces which API-key integration. */
const CLI_FOR_PROVIDER: Readonly<Record<string, CliId>> = {
  claude: 'claude',
  anthropic: 'claude',
  openai: 'codex',
  gemini: 'gemini',
};

export function cliForProvider(providerId: string): CliId | null {
  return CLI_FOR_PROVIDER[providerId.trim().toLowerCase()] ?? null;
}
