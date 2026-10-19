import type { RequestContext } from '../../shared/context.js';

export interface HealthStatus {
  readonly status: 'ok';
  readonly requestId: string;
}

export function getHealthStatus(context: RequestContext): HealthStatus {
  return {
    status: 'ok',
    requestId: context.requestId,
  };
}
