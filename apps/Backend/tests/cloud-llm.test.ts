import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicLlmProvider,
  GroqLlmProvider,
  OpenAiLlmProvider,
} from '../src/modules/agents/adapters/cloud-llm.js';

describe('cloud LLM providers', () => {
  it('returns provider usage and the actual model for cost accounting', async () => {
    const openai = new OpenAiLlmProvider({
      apiKey: 'key',
      model: 'configured',
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            model: 'served-model',
            choices: [{ message: { content: 'done' } }],
            usage: { prompt_tokens: 120, completion_tokens: 35 },
          }),
        ),
      ),
    });
    await expect(openai.complete({ prompt: 'task' })).resolves.toMatchObject({
      model: 'served-model',
      usage: { inputTokens: 120, outputTokens: 35 },
    });
    const claude = new AnthropicLlmProvider({
      apiKey: 'key',
      model: 'configured',
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            model: 'claude-served',
            content: [{ type: 'text', text: 'done' }],
            usage: { input_tokens: 42, output_tokens: 18 },
          }),
        ),
      ),
    });
    await expect(claude.complete({ prompt: 'task' })).resolves.toMatchObject({
      model: 'claude-served',
      usage: { inputTokens: 42, outputTokens: 18 },
    });
  });
  it('calls OpenAI-compatible chat completions with workspace credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'answer' } }] }), {
        status: 200,
      }),
    );
    const provider = new OpenAiLlmProvider({ apiKey: ' key ', model: ' model ', fetcher });
    await expect(
      provider.complete({
        prompt: 'hello',
        instruction: 'system',
        images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }],
      }),
    ).resolves.toEqual({
      provider: 'OpenAI',
      text: 'answer',
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer key' }),
      }),
    );
    const request = fetcher.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(request.body)).messages[1].content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
    ]);
  });

  it('supports Groq streaming and reports invalid responses', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'groq answer' } }] })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [] })));
    const provider = new GroqLlmProvider({ apiKey: 'key', model: 'model', fetcher });
    const chunks: string[] = [];
    for await (const chunk of provider.stream({ prompt: 'hello' })) chunks.push(chunk);
    expect(chunks).toEqual(['groq answer']);
    await expect(provider.complete({ prompt: 'again' })).rejects.toThrow(
      'Groq returned an invalid response.',
    );
  });

  it('maps Claude messages and reports HTTP errors', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'claude answer' }] })),
      )
      .mockResolvedValueOnce(new Response('', { status: 401 }));
    const provider = new AnthropicLlmProvider({
      apiKey: 'key',
      model: 'model',
      baseUrl: 'https://example.test/v1/',
      fetcher,
    });
    await expect(provider.complete({ prompt: 'hello', instruction: 'system' })).resolves.toEqual({
      provider: 'Claude',
      text: 'claude answer',
    });
    await expect(provider.complete({ prompt: 'again' })).rejects.toThrow(
      'Claude provider returned HTTP 401.',
    );
  });

  it('rejects missing credentials and provider HTTP failures', async () => {
    expect(() => new OpenAiLlmProvider({ apiKey: '', model: 'model' })).toThrow(
      'API key and model are required.',
    );
    expect(() => new OpenAiLlmProvider({ apiKey: 'key', model: '' })).toThrow(
      'API key and model are required.',
    );
    const provider = new OpenAiLlmProvider({
      apiKey: 'key',
      model: 'model',
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 })),
    });
    await expect(provider.complete({ prompt: 'hello' })).rejects.toThrow(
      'OpenAI provider returned HTTP 429.',
    );
  });
});
