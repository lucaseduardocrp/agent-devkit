export type Lang = 'pt' | 'en';

export interface Messages {
  denied(userId: string): string;
  privateOnly: string;
  unknownCommand(name: string): string;
  help: string;
  working: string;
  empty: string;
  cancelled: string;
  nothingRunning: string;
  failed(cli: string, detail: string): string;
  unknownCli(id: string, ids: string): string;
  cliSet(name: string, resumed: boolean): string;
  newSession: string;
  modeSet(mode: string): string;
  modeUsage: string;
  status(cli: string, mode: string, session: string, busy: boolean): string;
  scheduleUsage: string;
  scheduled(id: number, when: string): string;
  noTasks: string;
  taskRemoved(id: number): string;
  taskNotFound(id: number): string;
  unscheduleUsage: string;
  taskResult(id: number, text: string): string;
  taskFailed(id: number, cli: string, detail: string): string;
  notInstalled: string;
  sessionNone: string;
  sessionActive: string;
  authNeeded(cli: string, hint: string): string;
  authSaved(cli: string): string;
  authCleared(cli: string): string;
  authNothing(cli: string): string;
  authUnrecognized(cli: string, hint: string): string;
  authUnsupported(cli: string): string;
  authUsage: string;
  authHeader: string;
  authYes: string;
  authNo: string;
  mcpHeader: string;
  mcpNone: string;
  mcpSaved(name: string): string;
  mcpRemoved(name: string): string;
  mcpNotFound(name: string): string;
  mcpUsage: string;
  mcpBadName: string;
  mcpBadUrl: string;
  mcpLimit(max: number): string;
}

const dictionary: Record<Lang, Messages> = {
  pt: {
    denied: (userId: string) =>
      `Acesso negado. Seu id do Telegram é ${userId}: peça ao administrador para incluí-lo em BRIDGE_ALLOWED_USER_IDS.`,
    privateOnly: 'Só converso em chat privado.',
    unknownCommand: (name: string) => `Comando /${name} desconhecido. Use /help.`,
    help: 'Comandos',
    working: 'Trabalhando…',
    empty: '(a CLI terminou sem resposta)',
    cancelled: 'Cancelado.',
    nothingRunning: 'Nada em execução.',
    failed: (cli: string, detail: string) =>
      `❌ ${cli} falhou:\n${detail}\n\nSe a conversa parece quebrada, use /new.`,
    unknownCli: (id: string, ids: string) => `CLI "${id}" não existe. Disponíveis: ${ids}.`,
    cliSet: (name: string, resumed: boolean) =>
      `Agora usando ${name}${resumed ? ' (conversa anterior retomada)' : ''}.`,
    newSession: 'Nova conversa iniciada.',
    modeSet: (mode: string) => `Modo: ${mode}.`,
    modeUsage: 'Use /mode safe (só leitura) ou /mode auto (edita arquivos e roda comandos).',
    status: (cli: string, mode: string, session: string, busy: boolean) =>
      `CLI: ${cli}\nModo: ${mode}\nConversa: ${session}\n${busy ? 'Executando agora.' : 'Ocioso.'}`,
    scheduleUsage: 'Uso: /schedule every 30m <prompt> ou /schedule daily 09:00 <prompt>',
    scheduled: (id: number, when: string) => `Tarefa #${id} agendada (${when}).`,
    noTasks: 'Nenhuma tarefa agendada.',
    taskRemoved: (id: number) => `Tarefa #${id} removida.`,
    taskNotFound: (id: number) => `Tarefa #${id} não encontrada.`,
    unscheduleUsage: 'Uso: /unschedule <id>',
    taskResult: (id: number, text: string) => `🕒 Tarefa #${id}\n${text}`,
    taskFailed: (id: number, cli: string, detail: string) =>
      `🕒 Tarefa #${id}: ${cli} falhou:\n${detail}`,
    notInstalled: 'não instalada',
    sessionNone: 'nova',
    sessionActive: 'ativa',
    authNeeded: (cli: string, hint: string) =>
      'Conecte sua conta ' + cli + ' primeiro: /auth ' + cli + ' <chave>. ' + hint,
    authSaved: (cli: string) =>
      'Credencial de ' + cli + ' salva só para você. A mensagem com a chave foi apagada do chat.',
    authCleared: (cli: string) => 'Credencial de ' + cli + ' removida.',
    authNothing: (cli: string) => 'Você não tem credencial de ' + cli + '.',
    authUnrecognized: (cli: string, hint: string) =>
      'Não reconheci essa chave para ' + cli + '. ' + hint,
    authUnsupported: (cli: string) => cli + ' não usa conta por usuário.',
    authUsage: 'Use /auth <cli> <chave> para conectar sua conta, /logout <cli> para remover.',
    authHeader: 'Suas contas:',
    authYes: 'conectada',
    authNo: 'não conectada',
    mcpHeader: 'Seus servidores MCP:',
    mcpNone: 'Você ainda não conectou nenhum servidor MCP.',
    mcpSaved: (name: string) =>
      'Servidor MCP ' +
      name +
      ' conectado às suas CLIs. Vale a partir da próxima mensagem (use /new para começar uma conversa que já o conheça).',
    mcpRemoved: (name: string) => 'Servidor MCP ' + name + ' removido.',
    mcpNotFound: (name: string) => 'Você não tem um servidor MCP chamado ' + name + '.',
    mcpUsage:
      'Use /mcp para listar, /mcp add <nome> <url> <token> para conectar e /mcp remove <nome> para remover.',
    mcpBadName: 'O nome deve ter só letras minúsculas, números, - ou _ (até 32 caracteres).',
    mcpBadUrl: 'A URL deve começar com https:// (http só para endereços .internal ou localhost).',
    mcpLimit: (max: number) =>
      'Você já tem ' + max + ' servidores MCP. Remova um antes de adicionar outro.',
  },
  en: {
    denied: (userId: string) =>
      `Access denied. Your Telegram id is ${userId}: ask the administrator to add it to BRIDGE_ALLOWED_USER_IDS.`,
    privateOnly: 'I only talk in private chats.',
    unknownCommand: (name: string) => `Unknown command /${name}. Use /help.`,
    help: 'Commands',
    working: 'Working…',
    empty: '(the CLI finished without an answer)',
    cancelled: 'Cancelled.',
    nothingRunning: 'Nothing is running.',
    failed: (cli: string, detail: string) =>
      `❌ ${cli} failed:\n${detail}\n\nIf the conversation looks broken, use /new.`,
    unknownCli: (id: string, ids: string) => `CLI "${id}" does not exist. Available: ${ids}.`,
    cliSet: (name: string, resumed: boolean) =>
      `Now using ${name}${resumed ? ' (previous conversation resumed)' : ''}.`,
    newSession: 'New conversation started.',
    modeSet: (mode: string) => `Mode: ${mode}.`,
    modeUsage: 'Use /mode safe (read only) or /mode auto (edits files and runs commands).',
    status: (cli: string, mode: string, session: string, busy: boolean) =>
      `CLI: ${cli}\nMode: ${mode}\nConversation: ${session}\n${busy ? 'Running now.' : 'Idle.'}`,
    scheduleUsage: 'Usage: /schedule every 30m <prompt> or /schedule daily 09:00 <prompt>',
    scheduled: (id: number, when: string) => `Task #${id} scheduled (${when}).`,
    noTasks: 'No scheduled tasks.',
    taskRemoved: (id: number) => `Task #${id} removed.`,
    taskNotFound: (id: number) => `Task #${id} not found.`,
    unscheduleUsage: 'Usage: /unschedule <id>',
    taskResult: (id: number, text: string) => `🕒 Task #${id}\n${text}`,
    taskFailed: (id: number, cli: string, detail: string) =>
      `🕒 Task #${id}: ${cli} failed:\n${detail}`,
    notInstalled: 'not installed',
    sessionNone: 'new',
    sessionActive: 'active',
    authNeeded: (cli: string, hint: string) =>
      'Connect your ' + cli + ' account first: /auth ' + cli + ' <key>. ' + hint,
    authSaved: (cli: string) =>
      'Credential for ' +
      cli +
      ' saved for you only. The message with the key was deleted from the chat.',
    authCleared: (cli: string) => 'Credential for ' + cli + ' removed.',
    authNothing: (cli: string) => 'You have no credential for ' + cli + '.',
    authUnrecognized: (cli: string, hint: string) =>
      'I did not recognize that key for ' + cli + '. ' + hint,
    authUnsupported: (cli: string) => cli + ' does not use per-user accounts.',
    authUsage: 'Use /auth <cli> <key> to connect your account, /logout <cli> to remove it.',
    authHeader: 'Your accounts:',
    authYes: 'connected',
    authNo: 'not connected',
    mcpHeader: 'Your MCP servers:',
    mcpNone: 'You have not connected any MCP server yet.',
    mcpSaved: (name: string) =>
      'MCP server ' +
      name +
      ' connected to your CLIs. It applies from your next message (use /new to start a conversation that already knows it).',
    mcpRemoved: (name: string) => 'MCP server ' + name + ' removed.',
    mcpNotFound: (name: string) => 'You have no MCP server called ' + name + '.',
    mcpUsage:
      'Use /mcp to list, /mcp add <name> <url> <token> to connect and /mcp remove <name> to remove.',
    mcpBadName: 'The name must be lowercase letters, digits, - or _ (up to 32 characters).',
    mcpBadUrl: 'The URL must start with https:// (http only for .internal or localhost addresses).',
    mcpLimit: (max: number) =>
      'You already have ' + max + ' MCP servers. Remove one before adding another.',
  },
};

export function messagesFor(lang: Lang): Messages {
  return dictionary[lang];
}
