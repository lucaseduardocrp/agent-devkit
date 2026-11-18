import { describe, expect, it } from 'vitest';
import type { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';
import { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';
import { InMemoryUsageStore } from '../src/modules/issues/usage-store.js';

const service = {
  listIntegrations: () =>
    Promise.resolve([
      {
        id: 'llm-id',
        category: 'LLM',
        providerId: 'anthropic',
        isEnabled: true,
        settings: { model: 'claude-sonnet-5-5' },
        hasSecret: true,
        updatedAt: new Date(0).toISOString(),
      },
    ]),
  getDecryptedSecret: () => Promise.resolve('sk-test'),
} as unknown as IntegrationsService;

const fetcher = (() =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        content: [{ type: 'text', text: 'hi' }],
        model: 'claude-sonnet-5-5',
        usage: { input_tokens: 200, output_tokens: 50 },
      }),
    ),
  )) as unknown as typeof fetch;

function factory(withRecorder = true) {
  const store = new InMemoryUsageStore();
  const instance = new DynamicProviderFactory(service, fetcher);
  if (withRecorder) instance.setUsageRecorder(store);
  return { store, instance };
}

const events = (store: InMemoryUsageStore) => store.list('ws-1', new Date(0));

describe('metering of the models the factory hands out', () => {
  it('counts every call under the workspace, with the feature that asked for it', async () => {
    const { store, instance } = factory();

    const llm = await instance.resolveLlmProvider('ws-1', undefined, undefined, undefined, {
      tool: 'spec_chat',
      actorId: 'user-1',
    });
    await llm!.complete({ prompt: 'hello' });

    expect(await events(store)).toMatchObject([
      {
        workspaceId: 'ws-1',
        actorId: 'user-1',
        source: 'api',
        tool: 'spec_chat',
        provider: 'claude',
        model: 'claude-sonnet-5-5',
        inputTokens: 200,
        outputTokens: 50,
        estimated: false,
      },
    ]);
  });

  it('names the feature "llm" when the caller names none', async () => {
    const { store, instance } = factory();

    await (await instance.resolveLlmProvider('ws-1'))!.complete({ prompt: 'hello' });

    expect((await events(store))[0]).toMatchObject({ tool: 'llm', actorId: null });
  });

  it('leaves out callers that record their own tokens, such as issue runs', async () => {
    const { store, instance } = factory();

    const llm = await instance.resolveLlmProvider('ws-1', undefined, undefined, undefined, false);
    await llm!.complete({ prompt: 'hello' });

    expect(await events(store)).toHaveLength(0);
  });

  it('answers unmetered when no usage store is connected', async () => {
    const { store, instance } = factory(false);

    await (await instance.resolveLlmProvider('ws-1'))!.complete({ prompt: 'hello' });

    expect(await events(store)).toHaveLength(0);
  });
});
