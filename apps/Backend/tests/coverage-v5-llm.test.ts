import { describe, expect, it } from 'vitest';
import { OpenAiLlmProvider } from '../src/modules/agents/adapters/cloud-llm.js';
import { GeminiLlmProvider } from '../src/modules/agents/adapters/gemini-llm.js';
import { OllamaLlmProvider } from '../src/modules/agents/adapters/ollama-llm.js';
import type { LlmPort } from '../src/modules/agents/application/agent-ports.js';

/** A provider that answers only when its request is cancelled. */
const waitsForAbort: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    const signal = init!.signal!;
    if (signal.aborted) reject(new Error('request aborted'));
    signal.addEventListener('abort', () => reject(new Error('request aborted')));
  });

const providers: [string, LlmPort][] = [
  ['OpenAI', new OpenAiLlmProvider({ apiKey: 'k', model: 'm', fetcher: waitsForAbort })],
  ['Gemini', new GeminiLlmProvider({ apiKey: 'k', model: 'm', fetcher: waitsForAbort })],
  ['Ollama', new OllamaLlmProvider({ fetcher: waitsForAbort })],
];

describe.each(providers)('%s provider cancellation', (_name, provider) => {
  it('cancels the request when the caller aborts mid-flight', async () => {
    const caller = new AbortController();
    const pending = provider.complete({ prompt: 'hello' }, caller.signal);
    caller.abort();
    await expect(pending).rejects.toThrow('request aborted');
  });

  it('does not send a live request for an already aborted caller', async () => {
    await expect(provider.complete({ prompt: 'hello' }, AbortSignal.abort())).rejects.toThrow(
      'request aborted',
    );
  });
});

describe.each([
  [
    'OpenAI',
    new OpenAiLlmProvider({ apiKey: 'k', model: 'm', timeoutMs: 5, fetcher: waitsForAbort }),
  ],
  [
    'Gemini',
    new GeminiLlmProvider({ apiKey: 'k', model: 'm', timeoutMs: 5, fetcher: waitsForAbort }),
  ],
  ['Ollama', new OllamaLlmProvider({ timeoutMs: 5, fetcher: waitsForAbort })],
] as [string, LlmPort][])('%s provider timeout', (_name, provider) => {
  it('cancels a request that outlives the timeout', async () => {
    await expect(provider.complete({ prompt: 'hello' })).rejects.toThrow('request aborted');
  });
});
