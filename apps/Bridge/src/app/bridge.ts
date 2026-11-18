import { builtinCommands } from '../commands/builtin.js';
import type { BridgeApi, Command } from '../commands/types.js';
import type { CliExecutor, CliRegistry } from '../core/cli-registry.js';
import { redactSecrets } from '../core/guard.js';
import { splitMessage } from '../core/text.js';
import {
  CliError,
  chatKey,
  identityOf,
  type Channel,
  type CliAdapter,
  type CliOutput,
  type IncomingMessage,
  type RunRequest,
} from '../core/types.js';
import type { BridgeConfig } from './config.js';
import type { CredentialStore } from './credential-store.js';
import type { Sandbox } from './sandbox.js';
import { messagesFor } from './messages.js';
import { Scheduler } from './scheduler.js';
import type { ScheduledTask, StateStore } from './state-store.js';

export interface BridgeDeps {
  readonly config: BridgeConfig;
  readonly channels: readonly Channel[];
  readonly registry: CliRegistry;
  readonly executor: CliExecutor;
  readonly store: StateStore;
  readonly credentials: CredentialStore;
  /** Gives each user a private HOME, project directory and OS user. */
  readonly sandbox: Sandbox;
  /** Extra commands, added to the built-in ones. */
  readonly commands?: readonly Command[];
  readonly now?: () => number;
}

const COMMAND = /^\/([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/;

/**
 * Connects chat apps to CLIs: checks who is talking, routes slash commands, and turns every other
 * message into a prompt for the chat's CLI, as if a person typed it into that CLI.
 */
export class Bridge implements BridgeApi {
  readonly config: BridgeConfig;
  readonly registry: CliRegistry;
  readonly executor: CliExecutor;
  readonly store: StateStore;
  readonly credentials: CredentialStore;
  readonly scheduler: Scheduler;
  private readonly sandbox: Sandbox;

  private readonly channels = new Map<string, Channel>();
  private readonly commandList: Command[];
  private readonly runs = new Map<string, AbortController>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly controller = new AbortController();

  constructor(deps: BridgeDeps) {
    this.config = deps.config;
    this.registry = deps.registry;
    this.executor = deps.executor;
    this.store = deps.store;
    this.credentials = deps.credentials;
    this.sandbox = deps.sandbox;
    this.commandList = [...builtinCommands, ...(deps.commands ?? [])];
    for (const channel of deps.channels) this.channels.set(channel.id, channel);
    this.scheduler = new Scheduler({
      store: deps.store,
      now: deps.now,
      run: (task) => this.runTask(task),
    });
  }

  commands(): readonly Command[] {
    return this.commandList;
  }

  /** Starts every channel and the scheduler. Resolves when `stop()` is called. */
  async start(): Promise<void> {
    this.scheduler.start();
    await Promise.all(
      [...this.channels.values()].map((channel) =>
        channel.start((message) => this.handle(message), this.controller.signal),
      ),
    );
  }

  stop(): void {
    this.scheduler.stop();
    this.controller.abort();
    for (const run of this.runs.values()) run.abort();
  }

  cancel(key: string): boolean {
    const run = this.runs.get(key);
    run?.abort();
    return Boolean(run);
  }

  isBusy(key: string): boolean {
    return this.runs.has(key);
  }

  /** One message from a chat app. Never throws: errors go back to the chat. */
  async handle(message: IncomingMessage): Promise<void> {
    const t = messagesFor(this.config.lang);
    const reply = (text: string): Promise<void> => this.send(message.channel, message.chatId, text);
    const text = message.text.trim();
    if (!text) return;
    const command = COMMAND.exec(text);

    // Anyone can learn their id (needed to be allowed); nothing else is answered to strangers.
    if (command?.[1]?.toLowerCase() === 'whoami') return reply(String(message.userId));
    if (!message.isPrivate) return;
    const trusted = this.channels.get(message.channel)?.trusted === true;
    if (!trusted && !this.config.allowedUserIds.has(message.userId))
      return reply(t.denied(message.userId));

    const key = chatKey(message.channel, message.chatId);
    if (!command) return this.enqueue(key, () => this.runPrompt(message, key, text));

    const name = command[1]!.toLowerCase();
    // Telegram sends /start when a chat opens: greet with the help.
    const found = this.commandList.find((c) => c.name === (name === 'start' ? 'help' : name));
    if (!found) return reply(t.unknownCommand(name));
    try {
      await found.run({
        bridge: this,
        message,
        key,
        identity: identityOf(message),
        args: command[2] ?? '',
        t,
        lang: this.config.lang,
        reply,
      });
    } catch (error) {
      await reply(error instanceof Error ? error.message : String(error));
    }
  }

  /** Sends a reply split to what the channel accepts. */
  async send(channelId: string, chatId: string, text: string): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    for (const part of splitMessage(text, channel.maxMessageLength))
      await channel.send(chatId, part);
  }

  /** Messages of one chat run one after the other; commands skip the line. */
  private enqueue(key: string, job: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(key) ?? Promise.resolve())
      .then(job)
      .catch((error: unknown) => console.warn('[Bridge] Could not handle a message:', error))
      .finally(() => {
        if (this.queues.get(key) === next) this.queues.delete(key);
      });
    this.queues.set(key, next);
    return next;
  }

  private async runPrompt(message: IncomingMessage, key: string, prompt: string): Promise<void> {
    const t = messagesFor(this.config.lang);
    const chat = this.store.chat(key);
    const cliId = chat.cli ?? this.config.defaultCli;
    const adapter = this.registry.get(cliId);
    if (!adapter) {
      const ids = this.registry
        .list()
        .map((a) => a.id)
        .join(', ');
      return this.send(message.channel, message.chatId, t.unknownCli(cliId, ids));
    }

    const identity = identityOf(message);
    if (this.lacksAuth(adapter, identity))
      return this.send(
        message.channel,
        message.chatId,
        t.authNeeded(adapter.id, adapter.auth?.hint ?? ''),
      );

    const controller = new AbortController();
    this.runs.set(key, controller);
    const channel = this.channels.get(message.channel);
    const busy = (): void => void channel?.indicateBusy(message.chatId).catch(() => undefined);
    busy();
    const ticker = setInterval(busy, 4_000);
    try {
      const output = await this.execute(
        adapter,
        identity,
        {
          prompt,
          sessionId: adapter.supportsSessions ? chat.sessions[adapter.id] : undefined,
          autonomy: chat.mode ?? this.config.defaultMode,
        },
        controller.signal,
      );
      const sessionId = output.sessionId;
      if (sessionId) this.store.updateChat(key, (c) => (c.sessions[adapter.id] = sessionId));
      await this.send(
        message.channel,
        message.chatId,
        this.redact(identity, output.text || t.empty),
      );
    } catch (error) {
      const detail = error instanceof CliError ? error.message : String(error);
      // A /cancel already answered "Cancelled." through the command.
      if (!controller.signal.aborted)
        await this.send(
          message.channel,
          message.chatId,
          this.redact(identity, t.failed(adapter.name, detail)),
        );
    } finally {
      clearInterval(ticker);
      this.runs.delete(key);
    }
  }

  /** A scheduled task: always a fresh conversation, so unattended runs do not pile up context. */
  private async runTask(task: ScheduledTask): Promise<void> {
    const t = messagesFor(this.config.lang);
    const adapter = this.registry.get(task.cli);
    const send = (text: string): Promise<void> => this.send(task.channel, task.chatId, text);
    if (!adapter) {
      const ids = this.registry
        .list()
        .map((a) => a.id)
        .join(', ');
      await send(t.taskFailed(task.id, task.cli, t.unknownCli(task.cli, ids)));
      throw new CliError('unknown cli');
    }
    if (this.lacksAuth(adapter, task.identity)) {
      await send(
        t.taskFailed(task.id, adapter.name, t.authNeeded(adapter.id, adapter.auth?.hint ?? '')),
      );
      throw new CliError('not signed in');
    }
    try {
      const output = await this.execute(adapter, task.identity, {
        prompt: task.prompt,
        autonomy: task.mode,
      });
      await send(this.redact(task.identity, t.taskResult(task.id, output.text || t.empty)));
    } catch (error) {
      const detail = error instanceof CliError ? error.message : String(error);
      await send(this.redact(task.identity, t.taskFailed(task.id, adapter.name, detail))).catch(
        () => undefined,
      );
      throw error;
    }
  }

  private lacksAuth(adapter: CliAdapter, identity: string): boolean {
    return Boolean(adapter.auth) && !this.credentials.has(identity, adapter.id);
  }

  /**
   * Masks every secret the person holds, the bridge's own keys and anything shaped like a
   * credential, in text about to reach the chat. Catches a CLI that was talked into printing one.
   */
  private redact(identity: string, text: string): string {
    const { config } = this;
    const { text: safe, count } = redactSecrets(text, [
      ...this.credentials.secretsOf(identity),
      ...this.credentials.getMcp(identity).map((server) => server.token),
      ...[config.sharedToken, config.encryptionKey, config.telegramToken].filter(
        (secret): secret is string => Boolean(secret),
      ),
    ]);
    if (count) console.warn(`[Bridge] masked ${count} secret(s) in a reply to ${identity}.`);
    return safe;
  }

  /** Runs the CLI as this user: their HOME, project directory, OS user and credentials. */
  private async execute(
    adapter: CliAdapter,
    identity: string,
    request: Omit<RunRequest, 'cwd' | 'home' | 'mcpServers'>,
    signal?: AbortSignal,
  ): Promise<CliOutput> {
    // The user's own MCP servers, written in the way this CLI reads them.
    const mcpServers = this.credentials.getMcp(identity);
    const runtime = this.sandbox.resolve(identity, adapter.id, adapter.mcpFiles?.(mcpServers));
    // An audit trail of who ran what, how and for how long. Never the prompt or the answer.
    const started = Date.now();
    const record = (outcome: string): void =>
      console.log(
        `[Bridge] run ${JSON.stringify({ who: identity, cli: adapter.id, mode: request.autonomy, mcp: mcpServers.length, ms: Date.now() - started, outcome })}`,
      );
    try {
      const output = await this.executor.execute(
        adapter,
        { ...request, cwd: runtime.cwd, home: runtime.home, mcpServers },
        { signal, env: runtime.env, uid: runtime.uid, gid: runtime.gid },
      );
      record('ok');
      return output;
    } catch (error) {
      record(signal?.aborted ? 'cancelled' : 'failed');
      throw error;
    }
  }
}
