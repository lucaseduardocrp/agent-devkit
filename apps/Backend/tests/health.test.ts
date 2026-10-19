import { describe, expect, it } from 'vitest';
import { getHealthStatus } from '../src/health.js';

describe('health status', () => {
  it('returns ok', () => {
    expect(getHealthStatus()).toBe('ok');
  });
});
