import { DEFAULT_LOCALE, translateErrorMessage, type SupportedLocale } from './i18n.js';

export type ErrorDetail = Record<string, unknown>;
export type ErrorMessageParams = Readonly<Record<string, string | number>>;

export class ApplicationError extends Error {
  public constructor(
    public readonly code: string,
    public readonly technicalMessage: string,
    public readonly statusCode = 400,
    public readonly details: ErrorDetail[] = [],
    public readonly messageParams: ErrorMessageParams = {},
  ) {
    super(technicalMessage);
    this.name = 'ApplicationError';
  }
}

export function toErrorResponse(error: unknown, requestId: string, locale?: SupportedLocale) {
  const resolvedLocale = locale ?? DEFAULT_LOCALE;

  if (error instanceof ApplicationError) {
    return {
      code: error.code,
      message: translateErrorMessage(error.code, resolvedLocale, undefined, error.messageParams),
      details: error.details,
      correlationId: requestId,
    };
  }

  return {
    code: 'INTERNAL_ERROR',
    message: translateErrorMessage('INTERNAL_ERROR', resolvedLocale),
    details: [],
    correlationId: requestId,
  };
}
