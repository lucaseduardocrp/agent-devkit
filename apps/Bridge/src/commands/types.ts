import type { Lang, Messages } from '../app/messages.js';
import type { BridgeConfig } from '../app/config.js';
import type { CredentialStore } from '../app/credential-store.js';
import type { Scheduler } from '../app/scheduler.js';
import type { StateStore } from '../app/state-store.js';
import type { CliExecutor, CliRegistry } from '../core/cli-registry.js';
import type { IncomingMessage } from '../core/types.js';

/** What a command may use of the bridge. */
export interface BridgeApi {
  readonly config: BridgeConfig;
  readonly registry: CliRegistry;
  readonly executor: CliExecutor;
  readonly store: StateStore;
  readonly credentials: CredentialStore;
  readonly scheduler: Scheduler;
  /** Stops the run in progress for a chat. False when nothing was running. */
  cancel(key: string): boolean;
  isBusy(key: string): boolean;
  commands(): readonly Command[];
}

export interface CommandContext {
  readonly bridge: BridgeApi;
  readonly message: IncomingMessage;
  /** The conversation this message belongs to (see `chatKey`). */
  readonly key: string;
  /** Whose credentials this message may use (see `identityOf`). */
  readonly identity: string;
  /** Everything after the command name. */
  readonly args: string;
  readonly t: Messages;
  readonly lang: Lang;
  reply(text: string): Promise<void>;
}

/** A slash command. Add one to `builtinCommands` (or pass it to the bridge) to extend the bot. */
export interface Command {
  readonly name: string;
  readonly description: Record<Lang, string>;
  run(context: CommandContext): Promise<void>;
}
