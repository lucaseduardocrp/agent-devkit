import { describe, expect, it } from 'vitest';
import type { LlmPort, LlmResponse } from '../src/modules/agents/application/agent-ports.js';
import { MeteredLlm, estimateTokens } from '../src/modules/agents/application/metered-llm.js';
import { InMemoryUsageStore } from '../src/modules/issues/usage-store.js';

function fakeLlm(response: Partial<LlmResponse>, chunks: string[] = []): LlmPort {
  return {
    provider: 'Anthropic',
    complete: () => Promise.resolve({ provider: 'Anthropic', text: 'answer', ...response }),
    async *stream() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

const context = { workspaceId: 'ws-1', tool: 'spec_chat', source: 'api' as const };

describe('MeteredLlm', () => {
  it('records the exact usage a provider reports', async () => {
    const store = new InMemoryUsageStore();
    const llm = new MeteredLlm(
      fakeLlm({ model: 'claude-sonnet-5-5', usage: { inputTokens: 120, outputTokens: 30 } }),
      store,
      context,
    );

    await llm.complete({ prompt: 'hello' });

    const [event] = await store.list('ws-1', new Date(0));
    expect(event).toMatchObject({
      source: 'api',
      tool: 'spec_chat',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      inputTokens: 120,
      outputTokens: 30,
      estimated: false,
      costMicros: null,
    });
  });

  it('estimates tokens from the text when the provider reports none', async () => {
    const store = new InMemoryUsageStore();
    const llm = new MeteredLlm(fakeLlm({ text: 'x'.repeat(40) }), store, {
      ...context,
      source: 'cli',
      model: 'sonnet',
    });

    await llm.complete({ prompt: 'p'.repeat(80), instruction: 'i'.repeat(20) });

    const [event] = await store.list('ws-1', new Date(0));
    expect(event).toMatchObject({
      source: 'cli',
      model: 'sonnet',
      inputTokens: 25,
      outputTokens: 10,
      estimated: true,
    });
  });

  it('counts a stream, even one that was cut short', async () => {
    const store = new InMemoryUsageStore();
    const llm = new MeteredLlm(fakeLlm({}, ['ab', 'cd', 'ef']), store, context);

    for await (const chunk of llm.stream({ prompt: 'question' })) {
      if (chunk === 'cd') break;
    }

    const [event] = await store.list('ws-1', new Date(0));
    expect(event?.outputTokens).toBe(estimateTokens('abcd'));
    expect(event?.estimated).toBe(true);
  });

  it('keeps what the wrapped model can do, and counts nothing for an empty stream', async () => {
    const store = new InMemoryUsageStore();
    const inner: LlmPort = { ...fakeLlm({}), mcpAccess: 'read', readsFiles: true };
    const llm = new MeteredLlm(inner, store, context);

    expect(llm).toMatchObject({ provider: 'Anthropic', mcpAccess: 'read', readsFiles: true });
    for await (const chunk of llm.stream({ prompt: 'question' })) void chunk;

    expect(await store.list('ws-1', new Date(0))).toHaveLength(0);
  });

  it('still answers when the usage cannot be written', async () => {
    const llm = new MeteredLlm(
      fakeLlm({ text: 'fine' }),
      { record: () => Promise.reject(new Error('db down')) },
      context,
    );

    await expect(llm.complete({ prompt: 'hello' })).resolves.toMatchObject({ text: 'fine' });
  });

  it('does not count the offline deterministic model', async () => {
    const store = new InMemoryUsageStore();
    const inner: LlmPort = { ...fakeLlm({}), provider: 'deterministic' };

    await new MeteredLlm(inner, store, context).complete({ prompt: 'hello' });

    expect(await store.list('ws-1', new Date(0))).toHaveLength(0);
  });
});
