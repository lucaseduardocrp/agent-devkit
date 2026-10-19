import { describe, expect, it } from 'vitest';
import { ApplicationError, toErrorResponse } from '../src/shared/errors.js';

describe('error responses', () => {
  it('serializes application errors', () => {
    const error = new ApplicationError('INVALID_INPUT', 'Invalid input.', 422, [
      { field: 'prompt' },
    ]);

    expect(toErrorResponse(error, 'request-1')).toEqual({
      code: 'INVALID_INPUT',
      message: 'Entrada de dados inválida.',
      details: [{ field: 'prompt' }],
      correlationId: 'request-1',
    });
  });

  it('hides unexpected error details', () => {
    expect(toErrorResponse(new Error('secret'), 'request-1')).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Ocorreu um erro inesperado.',
      details: [],
      correlationId: 'request-1',
    });
  });

  it('does not expose the technical message for a known public error code', () => {
    const error = new ApplicationError('FORBIDDEN', 'Sensitive internal context.', 403);

    expect(toErrorResponse(error, 'request-2', 'en-US').message).toBe('Access denied.');
  });

  it('interpolates public message parameters without changing error details', () => {
    const error = new ApplicationError(
      'MODULE_ACCESS_BLOCKED',
      'Internal module access failure.',
      403,
      [{ module: 'design' }],
      { module: 'Design' },
    );

    expect(toErrorResponse(error, 'request-3', 'pt-BR')).toEqual({
      code: 'MODULE_ACCESS_BLOCKED',
      message: 'Acesso ao módulo Design bloqueado.',
      details: [{ module: 'design' }],
      correlationId: 'request-3',
    });
  });
});
