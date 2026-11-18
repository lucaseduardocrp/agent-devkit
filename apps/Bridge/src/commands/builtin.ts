import { describeSchedule, nextRun, parseSchedule } from '../app/schedule.js';
import { isAcceptableMcpUrl, MAX_MCP_SERVERS, MCP_NAME } from '../core/mcp.js';
import type { Autonomy } from '../core/types.js';
import type { Command, CommandContext } from './types.js';

/** The CLI and mode a chat is using right now. */
export function activeSettings(context: Pick<CommandContext, 'bridge' | 'key'>): {
  cli: string;
  mode: Autonomy;
} {
  const chat = context.bridge.store.chat(context.key);
  return {
    cli: chat.cli ?? context.bridge.config.defaultCli,
    mode: chat.mode ?? context.bridge.config.defaultMode,
  };
}

const help: Command = {
  name: 'help',
  description: { pt: 'Lista os comandos', en: 'Lists the commands' },
  async run({ bridge, reply, t, lang }) {
    const lines = bridge.commands().map((c) => `/${c.name} — ${c.description[lang]}`);
    await reply(`${t.help}:\n${lines.join('\n')}`);
  },
};

const cli: Command = {
  name: 'cli',
  description: {
    pt: 'Escolhe a CLI: /cli claude | codex | gemini …',
    en: 'Chooses the CLI: /cli claude | codex | gemini …',
  },
  async run(context) {
    const { bridge, args, key, reply, t } = context;
    const id = args.trim().toLowerCase();
    if (!id) {
      const { cli: current } = activeSettings(context);
      const available = bridge.registry
        .list()
        .map((a) => (a.id === current ? `• ${a.id} ✓` : `• ${a.id}`));
      return reply(available.join('\n'));
    }
    const adapter = bridge.registry.get(id);
    if (!adapter) {
      const ids = bridge.registry
        .list()
        .map((a) => a.id)
        .join(', ');
      return reply(t.unknownCli(id, ids));
    }
    bridge.store.updateChat(key, (chat) => (chat.cli = adapter.id));
    await reply(t.cliSet(adapter.name, Boolean(bridge.store.chat(key).sessions[adapter.id])));
  },
};

const clis: Command = {
  name: 'clis',
  description: { pt: 'Mostra as CLIs instaladas', en: 'Shows which CLIs are installed' },
  async run({ bridge, reply, t }) {
    const lines = await Promise.all(
      bridge.registry.list().map(async (adapter) => {
        const version = await bridge.executor.probe(adapter, bridge.config.workdir);
        return `${version ? '✅' : '⚠️'} ${adapter.id} (${adapter.name}) — ${version ?? t.notInstalled}`;
      }),
    );
    await reply(lines.join('\n'));
  },
};

const fresh: Command = {
  name: 'new',
  description: { pt: 'Começa uma nova conversa', en: 'Starts a new conversation' },
  async run(context) {
    const { cli: current } = activeSettings(context);
    context.bridge.store.updateChat(context.key, (chat) => delete chat.sessions[current]);
    await context.reply(context.t.newSession);
  },
};

const cancel: Command = {
  name: 'cancel',
  description: { pt: 'Interrompe a execução atual', en: 'Stops the current run' },
  async run({ bridge, key, reply, t }) {
    await reply(bridge.cancel(key) ? t.cancelled : t.nothingRunning);
  },
};

const status: Command = {
  name: 'status',
  description: { pt: 'Mostra CLI, modo e conversa', en: 'Shows CLI, mode and conversation' },
  async run(context) {
    const { cli: current, mode } = activeSettings(context);
    const { bridge, key, reply, t } = context;
    const session = bridge.store.chat(key).sessions[current];
    await reply(
      t.status(current, mode, session ? t.sessionActive : t.sessionNone, bridge.isBusy(key)),
    );
  },
};

const mode: Command = {
  name: 'mode',
  description: {
    pt: 'safe (só leitura) ou auto (edita e executa)',
    en: 'safe (read only) or auto (edits and runs)',
  },
  async run({ bridge, args, key, reply, t }) {
    const value = args.trim().toLowerCase();
    if (value !== 'safe' && value !== 'auto') return reply(t.modeUsage);
    bridge.store.updateChat(key, (chat) => (chat.mode = value));
    await reply(t.modeSet(value));
  },
};

const auth: Command = {
  name: 'auth',
  description: {
    pt: 'Conecta sua conta de uma CLI: /auth claude <chave>',
    en: 'Connects your account to a CLI: /auth claude <key>',
  },
  async run({ bridge, args, identity, reply, t }) {
    const [name, ...rest] = args.trim().split(/\s+/);
    if (!name) {
      const lines = bridge.registry
        .list()
        .filter((adapter) => adapter.auth)
        .map(
          (adapter) =>
            `${bridge.credentials.has(identity, adapter.id) ? '✅' : '▫️'} ${adapter.id} — ${
              bridge.credentials.has(identity, adapter.id) ? t.authYes : t.authNo
            }`,
        );
      return reply([t.authHeader, ...lines, '', t.authUsage].join('\n'));
    }
    const adapter = bridge.registry.get(name);
    if (!adapter) {
      const ids = bridge.registry
        .list()
        .map((a) => a.id)
        .join(', ');
      return reply(t.unknownCli(name, ids));
    }
    if (!adapter.auth) return reply(t.authUnsupported(adapter.id));
    const secret = rest.join(' ').trim();
    if (!secret) return reply(t.authNeeded(adapter.id, adapter.auth.hint));
    const credential = adapter.auth.classify(secret);
    if (!credential) return reply(t.authUnrecognized(adapter.id, adapter.auth.hint));
    bridge.credentials.set(identity, adapter.id, credential);
    await reply(t.authSaved(adapter.id));
  },
};

const logout: Command = {
  name: 'logout',
  description: {
    pt: 'Remove sua credencial: /logout claude',
    en: 'Removes your credential: /logout claude',
  },
  async run({ bridge, args, identity, reply, t }) {
    const adapter = bridge.registry.get(args.trim());
    if (!adapter) {
      const ids = bridge.registry
        .list()
        .map((a) => a.id)
        .join(', ');
      return reply(t.unknownCli(args.trim(), ids));
    }
    await reply(
      bridge.credentials.clear(identity, adapter.id)
        ? t.authCleared(adapter.id)
        : t.authNothing(adapter.id),
    );
  },
};

const mcp: Command = {
  name: 'mcp',
  description: {
    pt: 'Servidores MCP das suas CLIs: /mcp, /mcp add, /mcp remove',
    en: 'MCP servers for your CLIs: /mcp, /mcp add, /mcp remove',
  },
  async run({ bridge, args, identity, reply, t }) {
    const [action, name = '', url = '', ...rest] = args.trim().split(/\s+/);
    const servers = bridge.credentials.getMcp(identity);
    if (!action || action === 'list') {
      if (!servers.length) return reply(`${t.mcpNone}\n${t.mcpUsage}`);
      // The token is never shown back, only where each server is.
      return reply([t.mcpHeader, ...servers.map((s) => `• ${s.name} — ${s.url}`)].join('\n'));
    }
    if (action === 'remove') {
      return reply(
        bridge.credentials.clearMcp(identity, name) ? t.mcpRemoved(name) : t.mcpNotFound(name),
      );
    }
    if (action !== 'add') return reply(t.mcpUsage);
    const token = rest.join(' ').trim();
    if (!name || !url || !token) return reply(t.mcpUsage);
    if (!MCP_NAME.test(name)) return reply(t.mcpBadName);
    if (!isAcceptableMcpUrl(url)) return reply(t.mcpBadUrl);
    // Updating a server that already exists is always allowed; only new ones count to the limit.
    if (!servers.some((s) => s.name === name) && servers.length >= MAX_MCP_SERVERS)
      return reply(t.mcpLimit(MAX_MCP_SERVERS));
    bridge.credentials.setMcp(identity, { name, url, token });
    await reply(t.mcpSaved(name));
  },
};

const schedule: Command = {
  name: 'schedule',
  description: {
    pt: 'Agenda uma tarefa: /schedule every 30m <prompt>',
    en: 'Schedules a task: /schedule every 30m <prompt>',
  },
  async run(context) {
    const { bridge, args, message, key, reply, t } = context;
    const parsed = parseSchedule(args.trim());
    if (!parsed || !parsed.rest) return reply(t.scheduleUsage);
    const settings = activeSettings(context);
    const task = bridge.store.addTask({
      chatKey: key,
      identity: context.identity,
      chatId: message.chatId,
      channel: message.channel,
      cli: settings.cli,
      mode: settings.mode,
      prompt: parsed.rest,
      schedule: parsed.schedule,
      nextRunAt: nextRun(parsed.schedule, Date.now()),
    });
    await reply(t.scheduled(task.id, describeSchedule(task.schedule)));
  },
};

const tasks: Command = {
  name: 'tasks',
  description: { pt: 'Lista as tarefas agendadas', en: 'Lists scheduled tasks' },
  async run({ bridge, key, reply, t }) {
    const mine = bridge.store.tasks().filter((task) => task.chatKey === key);
    if (!mine.length) return reply(t.noTasks);
    await reply(
      mine
        .map((task) => {
          const state = task.lastStatus ? ` [${task.lastStatus}]` : '';
          return `#${task.id} ${describeSchedule(task.schedule)} · ${task.cli}/${task.mode}${state}\n${task.prompt}`;
        })
        .join('\n\n'),
    );
  },
};

const unschedule: Command = {
  name: 'unschedule',
  description: {
    pt: 'Remove uma tarefa: /unschedule <id>',
    en: 'Removes a task: /unschedule <id>',
  },
  async run({ bridge, args, key, reply, t }) {
    const id = Number(args.trim().replace(/^#/, ''));
    if (!Number.isInteger(id)) return reply(t.unscheduleUsage);
    await reply(bridge.store.removeTask(id, key) ? t.taskRemoved(id) : t.taskNotFound(id));
  },
};

export const builtinCommands: readonly Command[] = [
  help,
  cli,
  clis,
  auth,
  logout,
  mcp,
  fresh,
  cancel,
  status,
  mode,
  schedule,
  tasks,
  unschedule,
];
