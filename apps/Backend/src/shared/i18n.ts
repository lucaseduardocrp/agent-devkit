import { ptBR, type ErrorMessageCode } from './locales/pt-BR.js';
import { enUS } from './locales/en-US.js';

export type { ErrorMessageCode } from './locales/pt-BR.js';

export type SupportedLocale = 'pt-BR' | 'en-US';

export const DEFAULT_LOCALE: SupportedLocale = 'pt-BR';

export const SUPPORTED_LOCALES: readonly SupportedLocale[] = ['pt-BR', 'en-US'];

export function resolveLocale(input?: string | null): SupportedLocale {
  if (!input || typeof input !== 'string') {
    return DEFAULT_LOCALE;
  }

  const tokens = input
    .split(',')
    .map((part) => {
      const [tag = '', qPart] = part.split(';');
      const cleanTag = tag.trim().toLowerCase();
      let q = 1.0;
      if (qPart && qPart.trim().startsWith('q=')) {
        const parsedQ = parseFloat(qPart.trim().slice(2));
        if (!isNaN(parsedQ)) q = parsedQ;
      }
      return { tag: cleanTag, q };
    })
    .sort((a, b) => b.q - a.q);

  for (const { tag, q } of tokens) {
    if (q <= 0) continue;
    if (tag.startsWith('pt')) {
      return 'pt-BR';
    }
    if (tag.startsWith('en')) {
      return 'en-US';
    }
  }

  return DEFAULT_LOCALE;
}

export const ERROR_MESSAGES = { 'pt-BR': ptBR, 'en-US': enUS } as const;

export function translateErrorMessage(
  code: string,
  locale: SupportedLocale = DEFAULT_LOCALE,
  fallbackMessage?: string,
  params: Readonly<Record<string, string | number>> = {},
): string {
  const dictionary = ERROR_MESSAGES[locale];
  let message: string;
  if (code in dictionary) {
    message = dictionary[code as ErrorMessageCode];
  } else {
    message = fallbackMessage ?? dictionary.UNKNOWN_ERROR;
  }

  return interpolate(message, params);
}

const CONTENT_MESSAGES = {
  'pt-BR': {
    defaultTestPlanTitle: 'Plano de Testes Gerado',
    defaultAction: 'Executar o fluxo principal do teste',
    defaultExpected: 'Fluxo concluído com sucesso e dados validados',
    fallbackAction: 'Acessar e conduzir o fluxo de {subject}',
    fallbackExpected: 'Fluxo de {subject} executado passo a passo e validado com sucesso.',
    integrationCredentialsRequired: 'A chave de API e o modelo são obrigatórios.',
    integrationVerified: 'Conexão com {provider} verificada.',
    integrationHttpFailure: '{provider} respondeu com status {status}.',
    unknownProvider: 'Provider desconhecido: {provider}.',
    probeFailed: 'Falha ao testar a conexão: {reason}',
    documentDeleted: 'Documento excluído com sucesso.',
  },
  'en-US': {
    defaultTestPlanTitle: 'Generated Test Plan',
    defaultAction: 'Execute the main test flow',
    defaultExpected: 'Flow completed successfully and data validated',
    fallbackAction: 'Access and perform the {subject} flow',
    fallbackExpected: 'The {subject} flow is performed step by step and validated successfully.',
    integrationCredentialsRequired: 'API key and model are required.',
    integrationVerified: '{provider} connection verified.',
    integrationHttpFailure: '{provider} responded with status {status}.',
    unknownProvider: "Unknown provider '{provider}'.",
    probeFailed: 'Connection probe failed: {reason}',
    documentDeleted: 'Document deleted successfully.',
  },
} as const;

export type ContentMessageKey = keyof (typeof CONTENT_MESSAGES)['pt-BR'];

export function translateContent(
  key: ContentMessageKey,
  locale: SupportedLocale = DEFAULT_LOCALE,
  params: Readonly<Record<string, string | number>> = {},
): string {
  return interpolate(CONTENT_MESSAGES[locale][key], params);
}

function interpolate(template: string, params: Readonly<Record<string, string | number>>): string {
  let message = template;
  for (const [name, value] of Object.entries(params)) {
    message = message.replaceAll(`{${name}}`, String(value));
  }
  return message;
}
