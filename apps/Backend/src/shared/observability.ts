import type { RequestHandler } from 'express';

export interface LogRecord {
  readonly level: 'info';
  readonly event: 'http.request.completed';
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly statusCode: number;
  readonly durationMs: number;
}

export interface Logger {
  info(record: LogRecord): void;
}

export const consoleLogger: Logger = {
  info(record) {
    console.log(JSON.stringify(record));
  },
};

export function createRequestLogger(logger: Logger, now: () => number = Date.now): RequestHandler {
  return (request, response, next) => {
    const startedAt = now();
    response.on('finish', () => {
      const requestId = response.getHeader('x-request-id');
      logger.info({
        level: 'info',
        event: 'http.request.completed',
        requestId: typeof requestId === 'string' ? requestId : 'unknown',
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
        durationMs: Math.max(0, now() - startedAt),
      });
    });
    next();
  };
}
