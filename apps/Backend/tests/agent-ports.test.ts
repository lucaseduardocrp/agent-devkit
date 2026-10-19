import { describe, expect, it } from 'vitest';
import { DeterministicLlm, LlmRegistry } from '../src/modules/agents/application/agent-ports.js';

describe('agent ports', () => {
  it('completes and streams through a deterministic provider', async () => {
    const llm = new DeterministicLlm();
    await expect(llm.complete({ prompt: 'hello', instruction: 'say' })).resolves.toEqual({
      provider: 'deterministic',
      text: 'say: hello',
    });
    const tokens: string[] = [];
    for await (const token of llm.stream({ prompt: 'hello world' })) tokens.push(token);
    expect(tokens).toEqual(['hello', 'world']);
  });

  it('handles prompt errors and abort signals', async () => {
    const llm = new DeterministicLlm();
    await expect(llm.complete({ prompt: ' ' })).rejects.toThrow('Prompt is required.');
    const controller = new AbortController();
    controller.abort();
    const iterator = llm.stream({ prompt: 'hello' }, controller.signal);
    await expect(
      (async () => {
        for await (const token of iterator) return token;
        return undefined;
      })(),
    ).rejects.toThrow();
  });

  it('registers and resolves providers', () => {
    const registry = new LlmRegistry();
    const llm = new DeterministicLlm();
    registry.register(llm);
    expect(registry.get('deterministic')).toBe(llm);
    expect(() => registry.get('missing')).toThrow('not registered');
  });
});
