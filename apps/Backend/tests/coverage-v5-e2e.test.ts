import { describe, expect, it, vi } from 'vitest';
import {
  E2eExecutor,
  type E2eExecutorOptions,
} from '../src/modules/e2e/application/e2e-executor.js';
import type { E2eJob } from '../src/modules/e2e/application/e2e-queue.js';
import { InMemoryE2eStore } from '../src/modules/e2e/application/e2e-store.js';

describe('E2eExecutor publish jobs', () => {
  it('does nothing when the destination was cleared and no publication is pending', async () => {
    const store = new InMemoryE2eStore();
    const creation = await store.createCreation({
      workspaceId: 'ws',
      ownerId: 'ws',
      actorId: 'u',
      agentId: 'agent',
      name: 'x',
      mode: 'backend',
      scope: 'codebase',
      baseUrl: 'http://api',
      path: '/',
      username: null,
      passwordSecret: null,
      prd: 'p',
      prdFileNames: [],
      diff: null,
      instructions: null,
      locale: 'pt-BR',
      repository: null,
    });
    const update = vi.spyOn(store, 'updateCreation');
    const executor = new E2eExecutor({ store } as unknown as E2eExecutorOptions);
    await executor.run(
      { workspaceId: 'ws', creationId: creation.id, kind: 'publish' } as E2eJob,
      new AbortController().signal,
    );
    expect(update).not.toHaveBeenCalled();
  });
});
