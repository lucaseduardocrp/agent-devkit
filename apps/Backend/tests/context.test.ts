import { describe, expect, it } from 'vitest';
import { createRequestContext } from '../src/shared/context.js';

describe('request context', () => {
  it('creates a context with a request id', () => {
    expect(createRequestContext('request-1')).toEqual({ requestId: 'request-1' });
  });
});
