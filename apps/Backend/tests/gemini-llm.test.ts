import { describe, expect, it } from 'vitest';
import { GeminiLlmProvider } from '../src/modules/agents/adapters/gemini-llm.js';

describe('GeminiLlmProvider', () => {
  it('instantiates with default fetcher and timeout', () => {
    const provider = new GeminiLlmProvider({ apiKey: 'key' });
    expect(provider.provider).toBe('Gemini');
  });

  it('completes and streams completions from Gemini API', async () => {
    const mockFetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toContain('models/gemini-1.5-pro:generateContent?key=test-api-key');
      expect(init?.body).toBeDefined();

      return {
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: 'Generated Test Plan content' }],
              },
            },
          ],
        }),
      } as Response;
    };

    const provider = new GeminiLlmProvider({
      apiKey: 'test-api-key',
      model: 'gemini-1.5-pro',
      fetcher: mockFetcher,
    });

    expect(provider.provider).toBe('Gemini');

    const result = await provider.complete({ prompt: 'Create tests' });
    expect(result.provider).toBe('Gemini');
    expect(result.text).toBe('Generated Test Plan content');

    // Stream
    const chunks: string[] = [];
    for await (const chunk of provider.stream({ prompt: 'Create tests' })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(['Generated Test Plan content']);
  });

  it('throws on non-200 HTTP status', async () => {
    const mockFetcher = async () =>
      ({
        ok: false,
        status: 403,
      }) as Response;

    const provider = new GeminiLlmProvider({
      apiKey: 'invalid-key',
      fetcher: mockFetcher,
    });

    await expect(provider.complete({ prompt: 'test' })).rejects.toThrow(
      'Gemini provider returned HTTP 403',
    );
  });

  it('does not retry quota failures', async () => {
    let callCount = 0;
    const provider = new GeminiLlmProvider({
      apiKey: 'limited-key',
      fetcher: async () => {
        callCount += 1;
        return { ok: false, status: 429 } as Response;
      },
    });

    await expect(provider.complete({ prompt: 'test' })).rejects.toThrow(
      'Gemini provider returned HTTP 429',
    );
    expect(callCount).toBe(1);
  });

  it('retries on transient HTTP 503 and succeeds on retry', async () => {
    let callCount = 0;
    const mockFetcher = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 503,
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'Recovered response' }] } }],
        }),
      } as Response;
    };

    const provider = new GeminiLlmProvider({
      apiKey: 'test-key',
      fetcher: mockFetcher,
    });

    const res = await provider.complete({ prompt: 'test' });
    expect(callCount).toBe(2);
    expect(res.text).toBe('Recovered response');
  });

  it('exhausts retries on persistent HTTP 503 and throws last error', async () => {
    let callCount = 0;
    const mockFetcher = async () => {
      callCount++;
      return {
        ok: false,
        status: 503,
      } as Response;
    };

    const provider = new GeminiLlmProvider({
      apiKey: 'test-key',
      fetcher: mockFetcher,
    });

    await expect(provider.complete({ prompt: 'test' })).rejects.toThrow(
      'Gemini provider returned HTTP 503',
    );
    expect(callCount).toBe(3);
  });

  it('throws when Gemini returns empty or invalid candidates', async () => {
    const mockFetcher = async () =>
      ({
        ok: true,
        json: async () => ({ candidates: [] }),
      }) as Response;

    const provider = new GeminiLlmProvider({
      apiKey: 'test-key',
      fetcher: mockFetcher,
    });

    await expect(provider.complete({ prompt: 'test' })).rejects.toThrow(
      'Gemini provider returned an empty or invalid candidate',
    );
  });

  it('respects external abort signals', async () => {
    const mockFetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
      });
    };

    const provider = new GeminiLlmProvider({
      apiKey: 'key',
      fetcher: mockFetcher,
    });

    const controller = new AbortController();
    const promise = provider.complete({ prompt: 'test' }, controller.signal);
    controller.abort();

    await expect(promise).rejects.toThrow('Aborted');
  });

  it('formats instruction and activates json generationConfig when requested', async () => {
    let capturedBody: any;
    const mockFetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      expect(String(input)).toContain('models/gemini-2.5-flash:generateContent');
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '{"result": true}' }] } }],
        }),
      } as Response;
    };

    const provider = new GeminiLlmProvider({
      apiKey: 'key',
      model: 'gemini-1.5-flash', // should normalize to gemini-2.5-flash
      fetcher: mockFetcher,
    });

    const res = await provider.complete({
      prompt: 'Generate user',
      instruction: 'Return JSON only',
    });
    expect(res.text).toBe('{"result": true}');
    expect(capturedBody.contents[0].parts[0].text).toBe('Generate user');
    expect(capturedBody.system_instruction.parts[0].text).toBe('Return JSON only');
    expect(capturedBody.generationConfig.responseMimeType).toBe('application/json');
  });
});
