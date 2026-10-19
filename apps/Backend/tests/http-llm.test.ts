import { describe, expect, it } from 'vitest';
import { HttpLlmAdapter } from '../src/modules/agents/adapters/http-llm.js';

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

describe('HttpLlmAdapter', () => {
  it('sends a request and normalizes the provider response', async () => {
    let receivedHeaders: HeadersInit | undefined;
    const adapter = new HttpLlmAdapter({
      provider: 'fixture',
      endpoint: 'https://example.com/complete',
      apiKey: 'test-key',
      fetcher: async (_input, init) => {
        receivedHeaders = init?.headers;
        return response({ text: 'result' });
      },
    });

    await expect(adapter.complete({ prompt: 'hello' })).resolves.toEqual({
      provider: 'fixture',
      text: 'result',
    });
    expect(receivedHeaders).toMatchObject({ authorization: 'Bearer test-key' });
  });

  it('streams normalized text', async () => {
    const adapter = new HttpLlmAdapter({
      provider: 'fixture',
      endpoint: 'https://example.com/complete',
      fetcher: async () => response({ text: 'result' }),
    });
    const values: string[] = [];
    for await (const value of adapter.stream({ prompt: 'hello' })) values.push(value);
    expect(values).toEqual(['result']);
  });

  it('supports providers without API keys and external abort signals', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const adapter = new HttpLlmAdapter({
      provider: 'fixture',
      endpoint: 'https://example.com/complete',
      fetcher: async (_input, init) => {
        receivedSignal = init?.signal ?? undefined;
        return response({ text: 'result' });
      },
    });

    await expect(adapter.complete({ prompt: 'hello' }, controller.signal)).resolves.toEqual({
      provider: 'fixture',
      text: 'result',
    });
    expect(receivedSignal).toBeDefined();
  });

  it('supports the default fetcher and forwards external aborts', async () => {
    const defaultAdapter = new HttpLlmAdapter({
      provider: 'fixture',
      endpoint: 'https://example.com/complete',
    });
    expect(defaultAdapter.provider).toBe('fixture');

    const controller = new AbortController();
    const adapter = new HttpLlmAdapter({
      provider: 'fixture',
      endpoint: 'https://example.com/complete',
      fetcher: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    });
    const pending = adapter.complete({ prompt: 'hello' }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
  });

  it('aborts a request when the timeout is reached', async () => {
    const adapter = new HttpLlmAdapter({
      provider: 'fixture',
      endpoint: 'https://example.com/complete',
      timeoutMs: 1,
      fetcher: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    });

    await expect(adapter.complete({ prompt: 'hello' })).rejects.toThrow('aborted');
  });

  it('rejects provider failures and invalid output', async () => {
    const failed = new HttpLlmAdapter({
      provider: 'fixture',
      endpoint: 'https://example.com/complete',
      fetcher: async () => response({}, false, 503),
    });
    await expect(failed.complete({ prompt: 'hello' })).rejects.toThrow('HTTP 503');

    const invalid = new HttpLlmAdapter({
      provider: 'fixture',
      endpoint: 'https://example.com/complete',
      fetcher: async () => response({ text: ' ' }),
    });
    await expect(invalid.complete({ prompt: 'hello' })).rejects.toThrow('invalid response');

    const nonString = new HttpLlmAdapter({
      provider: 'fixture',
      endpoint: 'https://example.com/complete',
      fetcher: async () => response({ text: 42 }),
    });
    await expect(nonString.complete({ prompt: 'hello' })).rejects.toThrow('invalid response');
  });

  it('rejects unsafe endpoints', () => {
    expect(
      () =>
        new HttpLlmAdapter({
          provider: 'fixture',
          endpoint: 'file:///tmp/complete',
        }),
    ).toThrow('protocol is not allowed');
  });
});
