import { describe, expect, it } from 'vitest';
import {
  testPlanCreateSchema,
  searchQuerySchema,
  webhookPayloadSchema,
} from '../src/contracts/http.js';
import { parseBody, parseQuery } from '../src/adapters/http/validation.js';

describe('HTTP contracts', () => {
  it('parses valid request bodies and queries', () => {
    expect(testPlanCreateSchema.parse({ prompt: 'test' })).toEqual({ prompt: 'test' });
    expect(searchQuerySchema.parse({ prompt: 'test' })).toEqual({ prompt: 'test' });
    expect(webhookPayloadSchema.parse({ eventType: 'push' }).eventType).toBe('push');
  });

  it('returns safe validation details', () => {
    expect(() => parseBody(testPlanCreateSchema, { body: { prompt: '' } } as never)).toThrow(
      'Request validation failed.',
    );
    expect(() => parseQuery(searchQuerySchema, { query: { prompt: '' } } as never)).toThrow(
      'Query validation failed.',
    );
  });
});
