import type { E2eDispatcher } from '../application/e2e-service.js';
import type { E2eWorker } from '../application/e2e-worker.js';

/** Runs jobs inside the API process; used for local development and single-box setups. */
export class LocalE2eDispatcher implements E2eDispatcher {
  constructor(private readonly worker: Pick<E2eWorker, 'wake'>) {}

  wake(): Promise<void> {
    this.worker.wake();
    return Promise.resolve();
  }
}

export interface HttpE2eDispatcherOptions {
  /** Base URL of the worker service, e.g. https://your-e2e-worker.up.railway.app */
  readonly url: string;
  readonly token: string;
  readonly fetcher?: typeof fetch;
  readonly attempts?: number;
  /** A sleeping host may take a while to boot before it answers the wake request. */
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
}

/**
 * Wakes a remote, on-demand worker. The request itself is what makes platforms such as
 * Railway (serverless), Fly or Cloud Run start the sleeping instance.
 */
export class HttpE2eDispatcher implements E2eDispatcher {
  private readonly url: string;

  constructor(private readonly options: HttpE2eDispatcherOptions) {
    this.url = `${options.url.replace(/\/+$/, '')}/wake`;
  }

  async wake(): Promise<void> {
    const attempts = this.options.attempts ?? 3;
    const fetcher = this.options.fetcher ?? fetch;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetcher(this.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.options.token}` },
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
        });
        if (response.ok) return;
        lastError = new Error(`Worker answered HTTP ${response.status}`);
        // A rejected token will not start working on a retry.
        if (response.status === 401) break;
      } catch (error) {
        lastError = error;
      }
      if (attempt < attempts)
        await new Promise((resolve) =>
          setTimeout(resolve, (this.options.retryDelayMs ?? 2_000) * attempt),
        );
    }
    throw lastError;
  }
}
