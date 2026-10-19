import { describe, expect, it } from 'vitest';
import { OllamaLlmProvider } from '../src/modules/agents/adapters/ollama-llm.js';

describe('OllamaLlmProvider', () => {
  it('instantiates with default options and custom model', () => {
    const provider = new OllamaLlmProvider();
    expect(provider.provider).toBe('Ollama');

    const custom = new OllamaLlmProvider({ model: 'mistral' });
    expect(custom.provider).toBe('Ollama');
  });

  it('completes and streams responses from Ollama API', async () => {
    const mockFetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toContain('http://localhost:11434/api/generate');
      const body = JSON.parse(String(init?.body)) as { model: string; prompt: string };
      expect(body.model).toBe('llama3');
      expect(body.prompt).toBe('Generate test plan');

      return {
        ok: true,
        json: async () => ({
          response: 'Ollama generated response',
        }),
      } as Response;
    };

    const provider = new OllamaLlmProvider({
      fetcher: mockFetcher,
    });

    expect(provider.provider).toBe('Ollama');

    const result = await provider.complete({ prompt: 'Generate test plan' });
    expect(result.text).toBe('Ollama generated response');

    // Stream
    const chunks: string[] = [];
    for await (const chunk of provider.stream({ prompt: 'Generate test plan' })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(['Ollama generated response']);
  });

  it('throws on non-200 HTTP status', async () => {
    const mockFetcher = async () =>
      ({
        ok: false,
        status: 500,
      }) as Response;

    const provider = new OllamaLlmProvider({
      fetcher: mockFetcher,
    });

    await expect(provider.complete({ prompt: 'test' })).rejects.toThrow(
      'Ollama provider returned HTTP 500',
    );
  });

  it('throws on invalid response body', async () => {
    const mockFetcher = async () =>
      ({
        ok: true,
        json: async () => ({}),
      }) as Response;

    const provider = new OllamaLlmProvider({
      fetcher: mockFetcher,
    });

    await expect(provider.complete({ prompt: 'test' })).rejects.toThrow(
      'Ollama provider returned an invalid response',
    );
  });

  it('respects external abort signals', async () => {
    const mockFetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
      });
    };

    const provider = new OllamaLlmProvider({
      fetcher: mockFetcher,
    });

    const controller = new AbortController();
    const promise = provider.complete({ prompt: 'test' }, controller.signal);
    controller.abort();

    await expect(promise).rejects.toThrow('Aborted');
  });
});
