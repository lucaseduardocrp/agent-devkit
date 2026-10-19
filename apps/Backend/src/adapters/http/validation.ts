import type { Request } from 'express';
import type { z } from 'zod';
import { ApplicationError } from '../../shared/errors.js';

export function parseBody<T>(schema: z.ZodType<T>, request: Request): T {
  const result = schema.safeParse(request.body);
  if (!result.success) {
    throw new ApplicationError(
      'VALIDATION_ERROR',
      'Request validation failed.',
      400,
      result.error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path,
        field: issue.path.map(String).join('.'),
      })),
    );
  }

  return result.data;
}

export function parseParams<T>(schema: z.ZodType<T>, request: Request): T {
  const result = schema.safeParse(request.params);
  if (!result.success) {
    throw new ApplicationError(
      'VALIDATION_ERROR',
      'Route validation failed.',
      400,
      result.error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path,
        field: issue.path.map(String).join('.'),
      })),
    );
  }

  return result.data;
}

export function parseQuery<T>(schema: z.ZodType<T>, request: Request): T {
  const result = schema.safeParse(request.query);
  if (!result.success) {
    throw new ApplicationError(
      'VALIDATION_ERROR',
      'Query validation failed.',
      400,
      result.error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path,
        field: issue.path.map(String).join('.'),
      })),
    );
  }

  return result.data;
}
