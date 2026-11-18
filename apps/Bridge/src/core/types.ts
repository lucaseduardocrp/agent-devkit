/**
 * Contracts of the bridge. Everything else depends on these, never on a concrete CLI or chat app:
 * a new CLI implements `CliAdapter`, a new chat app implements `Channel`, a new feature adds a
 * `Command`.
 */

import type { McpServer } from './mcp.js';

/** How much the CLI may do without asking: `safe` reads only, `auto` edits and runs commands. */
export type Autonomy = 'safe' | 'auto';

export interface RunRequest {
  readonly prompt: string;
  /** The CLI's own conversation id, when continuing one. */
  readonly sessionId?: string;
  readonly autonomy: Autonomy;
  readonly cwd: string;
  /** The user's HOME, where files written by `mcpFiles` live. */
  readonly home?: string;
  /** The MCP servers this user connected, for CLIs that can use them. */
  readonly mcpServers?: readonly McpServer[];
}

/** A process to spawn. The bridge never goes through a shell. */
export interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
  /** Written to the process's standard input, then closed. */
  readonly stdin?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface CliOutput {
  readonly text: string;
  readonly sessionId?: string;
}

/** A CLI failed or answered with an error. The message is safe to show in the chat. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

/** A credential a user hands over, as the CLI expects to find it. */
export type CredentialInput =
  | { readonly kind: 'env'; readonly name: string; readonly value: string }
  /** `path` is relative to the user's HOME; the file is written once and the CLI keeps it fresh. */
  | { readonly kind: 'file'; readonly path: string; readonly content: string };

/** How a user signs a CLI in to their own account from the chat (`/auth`). */
export interface CliAuth {
  /** Tells the user where to get the secret. */
  readonly hint: string;
  /** Recognizes the secret and says where it goes; null when it is not one this CLI accepts. */
  classify(secret: string): CredentialInput | null;
}

/** One AI CLI: how to start it for a message and how to read what it printed. */
export interface CliAdapter {
  readonly id: string;
  readonly name: string;
  /** False for CLIs that cannot continue a conversation: every message starts a new one. */
  readonly supportsSessions: boolean;
  /**
   * Files (relative to the user's HOME) the CLI needs to see the user's MCP servers. Rewritten on
   * every run, so adding or removing a server takes effect on the next message. Each entry gets
   * the current content (or null) and returns the new one.
   */
  mcpFiles?(servers: readonly McpServer[]): Record<string, (current: string | null) => string>;
  /** Absent for CLIs that need no per-user account. */
  readonly auth?: CliAuth;
  /** Command used to check the CLI is installed. */
  readonly versionInvocation: Invocation;
  buildInvocation(request: RunRequest): Invocation;
  /** Throws `CliError` when the run failed. */
  parseOutput(result: ProcessResult): CliOutput;
}

export interface IncomingMessage {
  readonly channel: string;
  /** Where replies go. */
  readonly chatId: string;
  /** Who wrote it: access control is by user, not by chat. */
  readonly userId: string;
  /** The ADK member this chat belongs to (who paired it): the owner of the credentials. */
  readonly memberId?: string;
  readonly username?: string;
  readonly text: string;
  /** False for groups and channels: the bridge only talks in private. */
  readonly isPrivate: boolean;
}

export type MessageHandler = (message: IncomingMessage) => Promise<void>;

/** A chat app: delivers the user's messages and sends replies back. */
export interface Channel {
  readonly id: string;
  /** Longest text the app accepts in one message. */
  readonly maxMessageLength: number;
  /** True when the channel already checked who is talking, so the user allowlist is skipped. */
  readonly trusted?: boolean;
  /** Starts delivering messages to `handler`; resolves when stopped. */
  start(handler: MessageHandler, signal: AbortSignal): Promise<void>;
  send(chatId: string, text: string): Promise<void>;
  /** Shows that the bridge is working (e.g. "typing…"). Best effort. */
  indicateBusy(chatId: string): Promise<void>;
}

/** Who owns the credentials, files and sessions of a message. */
export function identityOf(message: Pick<IncomingMessage, 'channel' | 'userId' | 'memberId'>) {
  return message.memberId ? `member:${message.memberId}` : `${message.channel}:${message.userId}`;
}

/** Identifies a conversation across chat apps. */
export function chatKey(channel: string, chatId: string): string {
  return `${channel}:${chatId}`;
}
