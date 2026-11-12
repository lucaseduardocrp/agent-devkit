import type { SupportedLocale } from '../../../shared/i18n.js';
import type { TelegramBotCommand } from './telegram-api.js';

/** What the bot says, in the language of the Telegram user's app. */
const MESSAGES = {
  'pt-BR': {
    notPaired:
      'Este chat ainda não está conectado ao ADK. No ADK, abra Connect → Telegram, gere um código de pareamento e envie aqui: /start CODIGO',
    pairingInvalid:
      'Código inválido ou expirado. Gere um novo em Connect → Telegram e tente de novo.',
    paired:
      'Pronto, este chat está conectado ao workspace {workspace}. Envie uma mensagem para conversar com o agente. /help mostra os comandos.',
    groupsUnsupported: 'O ADK responde apenas em conversas privadas com o bot.',
    help: [
      'Envie uma mensagem para conversar com o agente do workspace.',
      '',
      '/agents: lista os agentes',
      '/agent <slug>: escolhe o agente deste chat (/agent padrao volta ao padrão)',
      '/new: começa uma nova conversa',
      '/notify on|off: liga ou desliga os avisos de execuções de teste',
      '/cli <id>: conversa com uma CLI de IA (claude, codex, gemini…); /agent volta aos agentes',
      '/mcp adk: liga as ferramentas do ADK às suas CLIs; /mcp lista, /mcp remove <nome> remove',
      '/unlink: desconecta este chat do ADK',
    ].join('\n'),
    agentsHeader: 'Agentes do workspace (o atual está marcado com •):',
    noAgents: 'Este workspace ainda não tem agentes. Crie um em Agents no ADK.',
    currentAgent: 'Agente atual: {agent}. Use /agent <slug> para trocar.',
    agentSet: 'Agente deste chat: {agent}.',
    agentUnknown: 'Não encontrei o agente "{slug}". /agents lista os disponíveis.',
    agentDefault: 'Este chat voltou a usar o agente padrão.',
    newConversation: 'Nova conversa iniciada.',
    notifyOn: 'Avisos de execuções de teste ligados.',
    notifyOff: 'Avisos de execuções de teste desligados.',
    notifyUsage: 'Use /notify on ou /notify off. Agora: {state}.',
    on: 'ligados',
    off: 'desligados',
    unlinked: 'Este chat foi desconectado do ADK.',
    unknownCommand: 'Comando desconhecido. /help mostra os comandos.',
    unsupportedMessage: 'Por enquanto o ADK entende apenas mensagens de texto.',
    agentFailed: 'Não consegui responder: {reason}',
    emptyAnswer: 'O agente não retornou resposta.',
    bridgeOff: 'As CLIs de IA não estão configuradas neste ADK. Veja docs/bridge.md.',
    mcpOff: 'O servidor MCP do ADK não está configurado (ADK_MCP_URL). Veja docs/bridge.md.',
    mcpFailed: 'Não consegui gerar o acesso ao MCP: {reason}',
    bridgeFailed: 'Não consegui falar com o Bridge das CLIs: {reason}',
    cliUnknown: 'Não encontrei a CLI "{cli}". Disponíveis: {available}.',
    cliSet: 'Este chat agora conversa com a CLI {cli}. /agent <slug> volta aos agentes.',
  },
  'en-US': {
    notPaired:
      'This chat is not connected to ADK yet. In ADK, open Connect → Telegram, generate a pairing code and send it here: /start CODE',
    pairingInvalid:
      'Invalid or expired code. Generate a new one in Connect → Telegram and try again.',
    paired:
      'Done, this chat is connected to the {workspace} workspace. Send a message to talk to the agent. /help lists the commands.',
    groupsUnsupported: 'ADK only answers in private chats with the bot.',
    help: [
      "Send a message to talk to the workspace's agent.",
      '',
      '/agents: list the agents',
      "/agent <slug>: choose this chat's agent (/agent default goes back to the default)",
      '/new: start a new conversation',
      '/notify on|off: turn test run notifications on or off',
      '/cli <id>: talk to an AI CLI (claude, codex, gemini…); /agent goes back to the agents',
      '/mcp adk: connect the ADK tools to your CLIs; /mcp lists, /mcp remove <name> removes',
      '/unlink: disconnect this chat from ADK',
    ].join('\n'),
    agentsHeader: "The workspace's agents (the current one is marked with •):",
    noAgents: 'This workspace has no agents yet. Create one under Agents in ADK.',
    currentAgent: 'Current agent: {agent}. Use /agent <slug> to change it.',
    agentSet: "This chat's agent: {agent}.",
    agentUnknown: 'There is no agent "{slug}". /agents lists them.',
    agentDefault: 'This chat uses the default agent again.',
    newConversation: 'New conversation started.',
    notifyOn: 'Test run notifications are on.',
    notifyOff: 'Test run notifications are off.',
    notifyUsage: 'Use /notify on or /notify off. Now: {state}.',
    on: 'on',
    off: 'off',
    unlinked: 'This chat was disconnected from ADK.',
    unknownCommand: 'Unknown command. /help lists the commands.',
    unsupportedMessage: 'For now ADK only understands text messages.',
    agentFailed: 'I could not answer: {reason}',
    emptyAnswer: 'The agent returned no answer.',
    bridgeOff: 'AI CLIs are not set up in this ADK. See docs/bridge.md.',
    mcpOff: 'The ADK MCP server is not configured (ADK_MCP_URL). See docs/bridge.md.',
    mcpFailed: 'I could not create the MCP access: {reason}',
    bridgeFailed: 'I could not reach the CLI Bridge: {reason}',
    cliUnknown: 'There is no CLI "{cli}". Available: {available}.',
    cliSet: 'This chat now talks to the {cli} CLI. /agent <slug> goes back to the agents.',
  },
} as const;

export type TelegramMessageKey = keyof (typeof MESSAGES)['pt-BR'];

export function telegramText(
  locale: SupportedLocale,
  key: TelegramMessageKey,
  params: Readonly<Record<string, string>> = {},
): string {
  return MESSAGES[locale][key].replace(
    /\{(\w+)\}/g,
    (match, name: string) => params[name] ?? match,
  );
}

/** The Telegram app's language: Portuguese for `pt*`, English otherwise. */
export function telegramLocale(languageCode: string | undefined): SupportedLocale {
  return languageCode?.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en-US';
}

/** The menu Telegram shows next to the message box. */
export const TELEGRAM_COMMANDS: readonly TelegramBotCommand[] = [
  { command: 'agents', description: 'List the workspace agents' },
  { command: 'agent', description: 'Choose the agent of this chat' },
  { command: 'cli', description: 'Talk to an AI CLI (Claude, Codex, ...)' },
  { command: 'mcp', description: 'Connect the ADK tools (MCP) to your CLIs' },
  { command: 'new', description: 'Start a new conversation' },
  { command: 'notify', description: 'Turn test run notifications on or off' },
  { command: 'help', description: 'Show the commands' },
  { command: 'unlink', description: 'Disconnect this chat from ADK' },
];
