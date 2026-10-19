import crypto from 'node:crypto';
import express from 'express';
import type { E2eWorker } from '../../modules/e2e/application/e2e-worker.js';

function sameToken(supplied: string | undefined, expected: string): boolean {
  const a = Buffer.from(supplied ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The worker's only HTTP surface: the API calls POST /wake when it enqueues work, which
 * also makes an on-demand host start the sleeping instance.
 */
export function createE2eWorkerApp(worker: Pick<E2eWorker, 'wake' | 'status'>, token: string) {
  const app = express();
  app.get('/health', (_request, response) => {
    response.json({ status: 'ok', ...worker.status });
  });
  app.post('/wake', (request, response) => {
    const supplied = request.header('authorization')?.replace(/^Bearer /, '');
    if (!sameToken(supplied, token)) {
      response.status(401).json({ code: 'UNAUTHORIZED' });
      return;
    }
    worker.wake();
    response.status(202).json({ status: 'waking', ...worker.status });
  });
  return app;
}
