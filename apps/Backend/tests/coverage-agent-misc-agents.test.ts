import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import {
  AnthropicLlmProvider,
  OpenAiLlmProvider,
} from '../src/modules/agents/adapters/cloud-llm.js';
import { GeminiLlmProvider } from '../src/modules/agents/adapters/gemini-llm.js';
import { HttpLlmAdapter } from '../src/modules/agents/adapters/http-llm.js';
import { InMemoryAgentRepository } from '../src/modules/agents/adapters/in-memory-agent-repository.js';
import { OllamaLlmProvider } from '../src/modules/agents/adapters/ollama-llm.js';
import type { LlmPort } from '../src/modules/agents/application/agent-ports.js';
import {
  AgentService,
  toLlmApplicationError,
} from '../src/modules/agents/application/agent-service.js';
import type { KnowledgeSearchPort } from '../src/modules/knowledge/application/knowledge-search.js';

const image = { mimeType: 'image/png', data: 'aGVsbG8=' } as const;
const json = (body: unknown) => new Response(JSON.stringify(body));
const sentBody = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>, call = 0) =>
  JSON.parse(String((fetcher.mock.calls[call]![1] as RequestInit).body)) as Record<string, unknown>;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentService execution edge cases', () => {
  function setup(search: KnowledgeSearchPort['search'], llm?: LlmPort) {
    const repository = new InMemoryAgentRepository();
    const complete = vi.fn(async () => ({ provider: 'Fake', text: 'Answer [x](https://evil)' }));
    const service = new AgentService({
      agentRepository: repository,
      defaultLlm: llm ?? ({ provider: 'Fake', complete } as unknown as LlmPort),
      knowledgeSearch: { search },
    });
    return { repository, service, complete };
  }

  it('answers from the Brain without calling the LLM when knowledge-only finds nothing', async () => {
    const { service, complete } = setup(async () => []);
    const agent = await service.createAgent('ws-1', { name: 'Docs', instructions: 'Answer.' });
    const result = await service.executeAgent('ws-1', agent.id, {
      prompt: 'Where?',
      includeKnowledge: true,
      knowledgeOnly: true,
    });
    expect(result).toMatchObject({
      result: 'Não encontrei essa informação no Brain.',
      provider: 'brain',
      agent: { id: agent.id },
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it('reports Brain failures for knowledge-only questions', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { service, complete } = setup(async () => {
      throw new Error('search down');
    });
    const agent = await service.createAgent('ws-1', { name: 'Docs', instructions: 'Answer.' });
    await expect(
      service.executeAgent('ws-1', agent.id, {
        prompt: 'Where?',
        includeKnowledge: true,
        knowledgeOnly: true,
      }),
    ).resolves.toMatchObject({
      result: 'Não foi possível consultar o Brain neste momento.',
      provider: 'brain',
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it('adds the strict Brain rule and forwards images to the LLM', async () => {
    const { service, complete } = setup(async () => [
      {
        id: 'k',
        ownerId: 'ws-1',
        source: 'https://wiki/page',
        pageId: 'p',
        chunkIndex: 0,
        content: 'Fact',
        score: 1,
        createdAt: 'now',
        updatedAt: 'now',
      },
    ]);
    const agent = await service.createAgent('ws-1', { name: 'Docs', instructions: 'Answer.' });
    const result = await service.executeAgent('ws-1', agent.id, {
      prompt: 'Explain',
      includeKnowledge: true,
      knowledgeOnly: true,
      images: [image],
    });
    expect(result).toEqual({ result: 'Answer x', agent: agent.toJSON(), provider: 'Fake' });
    const call = complete.mock.calls[0] as unknown as [{ instruction: string; images: unknown }];
    expect(call[0].instruction).toContain('REGRA ABSOLUTA');
    expect(call[0].images).toEqual([image]);
  });

  it('returns the served model and token usage reported by the LLM', async () => {
    const llm = {
      provider: 'Fake',
      complete: vi.fn(async () => ({
        provider: 'Fake',
        text: 'Done',
        model: 'served',
        usage: { inputTokens: 11, outputTokens: 4 },
      })),
    } as unknown as LlmPort;
    const { service } = setup(async () => [], llm);
    const agent = await service.createAgent('ws-1', { name: 'Docs', instructions: 'Answer.' });
    await expect(service.executeAgent('ws-1', agent.id, { prompt: 'Hi' })).resolves.toMatchObject({
      result: 'Done',
      model: 'served',
      usage: { inputTokens: 11, outputTokens: 4 },
    });
  });

  it('wraps LLM failures in application errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const llm = {
      provider: 'Fake',
      complete: vi
        .fn()
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockRejectedValueOnce('x'),
    } as unknown as LlmPort;
    const { service } = setup(async () => [], llm);
    const agent = await service.createAgent('ws-1', { name: 'Docs', instructions: 'Answer.' });
    await expect(service.executeAgent('ws-1', agent.id, { prompt: 'Hi' })).rejects.toMatchObject({
      code: 'LLM_EXECUTION_FAILED',
      statusCode: 502,
      message: 'socket hang up',
    });
    await expect(service.executeAgent('ws-1', agent.id, { prompt: 'Hi' })).rejects.toMatchObject({
      code: 'LLM_EXECUTION_FAILED',
      message: 'LLM execution failed.',
    });
    expect(toLlmApplicationError(new Error('HTTP 401 from provider'))).toMatchObject({
      code: 'LLM_AUTHENTICATION_FAILED',
    });
  });

  it('reports agents removed concurrently during deletion', async () => {
    const { repository, service } = setup(async () => []);
    const agent = await service.createAgent('ws-1', { name: 'Docs', instructions: 'Answer.' });
    vi.spyOn(repository, 'delete').mockResolvedValue(false);
    await expect(service.deleteAgent('ws-1', agent.id)).rejects.toMatchObject({
      code: 'AGENT_NOT_FOUND',
      statusCode: 404,
    });
  });
});

describe('POST /agents/default/brain-query', () => {
  function setup() {
    const agentService = new AgentService({
      agentRepository: new InMemoryAgentRepository(),
      knowledgeSearch: { search: async () => [] },
    });
    const app = createApp({
      agentService,
      requestContextResolver: async () => ({
        requestId: 'brain-query',
        ownerId: 'ws-brain',
        workspaceId: 'ws-brain',
        actorId: 'user-1',
        memberRole: 'ADMIN',
      }),
    });
    const execute = vi.spyOn(agentService, 'executeAgent');
    return { app, agentService, execute };
  }

  it('requires a configured agent', async () => {
    const { app } = setup();
    const response = await request(app)
      .post('/agents/default/brain-query')
      .send({ prompt: 'Question' });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('BRAIN_AGENT_NOT_CONFIGURED');
  });

  it('prefers the default agent, then documentation agents, then the first agent', async () => {
    const { app, agentService, execute } = setup();
    const first = await agentService.createAgent('ws-brain', {
      name: 'First',
      instructions: 'First.',
      role: 'QA',
    });
    const ask = () =>
      request(app).post('/agents/default/brain-query').send({ prompt: 'Question' }).expect(200);

    expect((await ask()).body).toMatchObject({
      agent: { id: first.id },
      provider: 'brain',
      result: 'Não encontrei essa informação no Brain.',
    });
    expect(execute).toHaveBeenLastCalledWith(
      'ws-brain',
      first.id,
      {
        prompt: 'Question',
        knowledgeQuery: 'Question',
        includeKnowledge: true,
        knowledgeOnly: true,
      },
      expect.objectContaining({ ownerId: 'ws-brain' }),
    );

    const docs = await agentService.createAgent('ws-brain', {
      name: 'Docs',
      instructions: 'Docs.',
      role: 'DOCUMENTATION',
    });
    expect((await ask()).body.agent.id).toBe(docs.id);

    const preferred = await agentService.createAgent('ws-brain', {
      name: 'Preferred',
      instructions: 'Preferred.',
      isDefault: true,
    });
    await request(app)
      .post('/agents/default/brain-query')
      .send({ prompt: 'Next?', history: 'User: hi' })
      .expect(200);
    expect(execute).toHaveBeenLastCalledWith(
      'ws-brain',
      preferred.id,
      expect.objectContaining({
        prompt: 'Conversa temporária:\nUser: hi\n\nPergunta atual:\nNext?',
        knowledgeQuery: 'Next?',
      }),
      expect.anything(),
    );
  });
});

describe('cloud LLM providers edge cases', () => {
  it('propagates caller aborts to the provider request', async () => {
    const fetcher = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init!.signal!;
          if (signal.aborted) reject(new Error('aborted early'));
          signal.addEventListener('abort', () => reject(new Error('aborted later')));
        }),
    );
    const provider = new OpenAiLlmProvider({ apiKey: 'key', model: 'model', fetcher });

    await expect(provider.complete({ prompt: 'x' }, AbortSignal.abort())).rejects.toThrow(
      'aborted early',
    );
    const controller = new AbortController();
    const pending = provider.complete({ prompt: 'x' }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('aborted later');
  });

  it('falls back to the configured model when usage has no model', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    );
    const provider = new OpenAiLlmProvider({ apiKey: 'key', model: 'gpt-x', fetcher });
    await expect(provider.complete({ prompt: 'x' })).resolves.toEqual({
      provider: 'OpenAI',
      text: 'ok',
      model: 'gpt-x',
      usage: { inputTokens: 1, outputTokens: 2 },
    });
  });

  it('sends Claude images and validates Claude responses', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          content: [{ type: 'text', text: 'seen' }],
          usage: { input_tokens: 3, output_tokens: 4 },
        }),
      )
      .mockResolvedValueOnce(json({ content: [{ type: 'image' }] }))
      .mockResolvedValueOnce(json({ content: [{ type: 'text', text: 'partial' }], usage: {} }));
    const provider = new AnthropicLlmProvider({ apiKey: 'key', model: 'claude-x', fetcher });

    await expect(provider.complete({ prompt: 'look', images: [image] })).resolves.toEqual({
      provider: 'Claude',
      text: 'seen',
      model: 'claude-x',
      usage: { inputTokens: 3, outputTokens: 4 },
    });
    expect(sentBody(fetcher)).toMatchObject({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
            },
          ],
        },
      ],
    });
    expect(sentBody(fetcher)).not.toHaveProperty('system');
    await expect(provider.complete({ prompt: 'again' })).rejects.toThrow(
      'Claude returned an invalid response.',
    );
    await expect(provider.complete({ prompt: 'again' })).resolves.toEqual({
      provider: 'Claude',
      text: 'partial',
    });
  });
});

describe('self-hosted and Gemini LLM usage reporting', () => {
  it('reports HTTP adapter usage only when model and token counts are present', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ text: 'a', model: 'm', usage: { inputTokens: 5, outputTokens: 6 } }),
      )
      .mockResolvedValueOnce(json({ text: 'b', model: 'm' }))
      .mockResolvedValueOnce(json({ text: 'c', model: 'm', usage: { inputTokens: 5 } }))
      .mockResolvedValueOnce(json({ text: 'd', model: 'm', usage: { outputTokens: 5 } }))
      .mockResolvedValueOnce(
        json({ text: 'e', model: 1, usage: { inputTokens: 5, outputTokens: 6 } }),
      );
    const adapter = new HttpLlmAdapter({
      provider: 'Custom',
      endpoint: 'https://example.com/complete',
      fetcher,
    });
    await expect(adapter.complete({ prompt: 'x' })).resolves.toEqual({
      provider: 'Custom',
      text: 'a',
      model: 'm',
      usage: { inputTokens: 5, outputTokens: 6 },
    });
    for (const text of ['b', 'c', 'd', 'e'])
      await expect(adapter.complete({ prompt: 'x' })).resolves.toEqual({
        provider: 'Custom',
        text,
      });
  });

  it('sends Gemini images and reports usage with complete counts only', async () => {
    const candidate = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          ...candidate('one'),
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 8 },
        }),
      )
      .mockResolvedValueOnce(json({ ...candidate('two'), usageMetadata: { promptTokenCount: 7 } }))
      .mockResolvedValueOnce(json({ ...candidate('three'), usageMetadata: {} }));
    const provider = new GeminiLlmProvider({ apiKey: 'key', model: 'gemini-x', fetcher });
    await expect(provider.complete({ prompt: 'look', images: [image] })).resolves.toEqual({
      provider: 'Gemini',
      text: 'one',
      model: 'gemini-x',
      usage: { inputTokens: 7, outputTokens: 8 },
    });
    expect(sentBody(fetcher)).toMatchObject({
      contents: [
        {
          parts: [{ text: 'look' }, { inline_data: { mime_type: 'image/png', data: 'aGVsbG8=' } }],
        },
      ],
    });
    await expect(provider.complete({ prompt: 'x' })).resolves.toEqual({
      provider: 'Gemini',
      text: 'two',
    });
    await expect(provider.complete({ prompt: 'x' })).resolves.toEqual({
      provider: 'Gemini',
      text: 'three',
    });
  });

  it('sends Ollama images and reports evaluation counts as usage', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ response: 'seen', prompt_eval_count: 9, eval_count: 10 }))
      .mockResolvedValueOnce(json({ response: 'partial', prompt_eval_count: 9 }));
    const provider = new OllamaLlmProvider({ model: 'llava', fetcher });
    await expect(provider.complete({ prompt: 'look', images: [image] })).resolves.toEqual({
      provider: 'Ollama',
      text: 'seen',
      model: 'llava',
      usage: { inputTokens: 9, outputTokens: 10 },
    });
    expect(sentBody(fetcher)).toMatchObject({ model: 'llava', images: ['aGVsbG8='] });
    await expect(provider.complete({ prompt: 'x', images: [] })).resolves.toEqual({
      provider: 'Ollama',
      text: 'partial',
    });
    expect(sentBody(fetcher, 1)).not.toHaveProperty('images');
  });
});
