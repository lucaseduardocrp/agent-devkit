import { describe, expect, it } from 'vitest';
import { getHealthStatus } from '../src/application/health/get-health-status.js';

describe('getHealthStatus', () => {
  it('returns an ok status with the request id', () => {
    expect(getHealthStatus({ requestId: 'request-1' })).toEqual({
      status: 'ok',
      requestId: 'request-1',
    });
  });
});
