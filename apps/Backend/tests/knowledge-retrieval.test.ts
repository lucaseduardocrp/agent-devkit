import { describe, expect, it, vi } from 'vitest';
import {
  parseKnowledgeQueryPlan,
  planKnowledgeQuery,
  searchKnowledgeWithPlan,
} from '../src/modules/knowledge/application/knowledge-retrieval.js';
import type { KnowledgeSearchPort } from '../src/modules/knowledge/application/knowledge-search.js';
import type { KnowledgeChunk } from '../src/modules/knowledge/domain/knowledge-chunk.js';

const context = { requestId: 'r', ownerId: 'ws' };
const chunk = (page: string, chunkIndex = 0): KnowledgeChunk => ({
  source: `app://local?title=${page}`,
  pageId: page,
  chunkIndex,
  content: `${page}-${chunkIndex}`,
  createdAt: 'now',
});

describe('parseKnowledgeQueryPlan', () => {
  it('reads the plan from JSON, even inside a code fence, and cleans it', () => {
    const long = 'x'.repeat(61);
    const plan = parseKnowledgeQueryPlan(
      `Claro:\n\`\`\`json\n{"standalone":"  Prazo   da aprovação? ","keywords":["aprovar"," Aprovar ","ab","${long}",7,"prazo"]}\n\`\`\``,
      'e o prazo?',
    );
    expect(plan).toEqual({ standalone: 'Prazo da aprovação?', keywords: ['aprovar', 'prazo'] });
  });

  it('caps the number of keywords and the length of the question', () => {
    const keywords = Array.from({ length: 20 }, (_, index) => `termo ${index}`);
    const plan = parseKnowledgeQueryPlan(
      JSON.stringify({ standalone: 'q'.repeat(500), keywords }),
      'q',
    );
    expect(plan?.keywords).toHaveLength(10);
    expect(plan?.standalone).toHaveLength(300);
  });

  it('falls back to the question when the standalone is missing but keywords exist', () => {
    expect(parseKnowledgeQueryPlan('{"keywords":["aprovação"]}', 'e o prazo?')).toEqual({
      standalone: 'e o prazo?',
      keywords: ['aprovação'],
    });
    expect(parseKnowledgeQueryPlan('{"standalone":"  ","keywords":"x"}', 'q')).toBeNull();
  });

  it('rejects anything that is not a plan', () => {
    expect(parseKnowledgeQueryPlan('sem json', 'q')).toBeNull();
    expect(parseKnowledgeQueryPlan('{ quebrado', 'q')).toBeNull();
    expect(parseKnowledgeQueryPlan('{"a":', 'q')).toBeNull();
    expect(parseKnowledgeQueryPlan('{"standalone":"q","keywords":[]}', 'q')).toBeNull();
    expect(parseKnowledgeQueryPlan('{ "x" } {', 'q')).toBeNull();
    expect(parseKnowledgeQueryPlan('null {}', 'q')).toBeNull();
  });
});

describe('planKnowledgeQuery', () => {
  it('sends the conversation and the question, and returns the plan', async () => {
    const complete = vi.fn(async () => ({
      text: '{"standalone":"Qual o prazo?","keywords":["prazo"]}',
    }));
    const plan = await planKnowledgeQuery({ complete }, 'e o prazo?', ' Você: aprovação ');
    expect(plan).toEqual({ standalone: 'Qual o prazo?', keywords: ['prazo'] });
    const request = (
      complete.mock.calls[0] as unknown as [{ prompt: string; instruction: string }]
    )[0];
    expect(request.prompt).toBe('Histórico:\nVocê: aprovação\n\nPergunta atual:\ne o prazo?');
    expect(request.instruction).toContain('apenas JSON');
  });

  it('omits the history when there is none and follows the caller signal', async () => {
    const complete = vi.fn(async (_request: unknown, signal?: AbortSignal) => {
      expect(signal?.aborted).toBe(true);
      return { text: '{"standalone":"q?","keywords":["abc"]}' };
    });
    await planKnowledgeQuery({ complete }, 'q', undefined, AbortSignal.abort());
    expect((complete.mock.calls[0]![0] as { prompt: string }).prompt).toBe('Pergunta atual:\nq');
  });

  it('returns null when the model fails or answers nothing usable', async () => {
    expect(
      await planKnowledgeQuery({ complete: vi.fn().mockRejectedValue(new Error('x')) }, 'q', ''),
    ).toBeNull();
    expect(
      await planKnowledgeQuery({ complete: vi.fn().mockResolvedValue({ text: 'oi' }) }, 'q', ''),
    ).toBeNull();
  });
});

describe('searchKnowledgeWithPlan', () => {
  const searchBy = (table: Record<string, KnowledgeChunk[]>): KnowledgeSearchPort => ({
    search: async (prompt) => table[prompt] ?? [],
  });

  it('searches only the question when there is no plan', async () => {
    const result = await searchKnowledgeWithPlan(
      searchBy({ q: [chunk('A'), chunk('B')] }),
      'q',
      null,
      context,
    );
    expect(result.map((item) => item.pageId)).toEqual(['A', 'B']);
  });

  it('ranks a document found through several terms above one found through a single term', async () => {
    const search = searchBy({
      'e o prazo?': [chunk('Solo')],
      'Qual o prazo?': [chunk('Solo'), chunk('Comum', 2), chunk('Comum', 0)],
      aprovar: [chunk('Comum', 1)],
      prazo: [chunk('Outro'), chunk('Comum', 0)],
    });
    const result = await searchKnowledgeWithPlan(
      search,
      'e o prazo?',
      { standalone: 'Qual o prazo?', keywords: ['aprovar', 'prazo'] },
      context,
    );
    // Comum is in three lists, Solo in two (the reworded question counts double), Outro in one.
    expect(result.map((item) => `${item.pageId}:${item.chunkIndex}`)).toEqual([
      'Comum:0',
      'Comum:1',
      'Comum:2',
      'Solo:0',
      'Outro:0',
    ]);
  });

  it('does not repeat a query and searches at most eight', async () => {
    const search = vi.fn(async (_query: string) => [] as KnowledgeChunk[]);
    await searchKnowledgeWithPlan(
      { search },
      'q',
      { standalone: 'q', keywords: ['q', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'] },
      context,
    );
    expect(search.mock.calls.map((call) => call[0])).toEqual([
      'q',
      'a1',
      'a2',
      'a3',
      'a4',
      'a5',
      'a6',
      'a7',
    ]);
  });

  it('skips a failed search, but fails when every search fails', async () => {
    const flaky: KnowledgeSearchPort = {
      search: async (prompt) => {
        if (prompt === 'bad') throw new Error('boom');
        return [chunk('A')];
      },
    };
    const result = await searchKnowledgeWithPlan(
      flaky,
      'q',
      { standalone: 'q', keywords: ['bad'] },
      context,
    );
    expect(result.map((item) => item.pageId)).toEqual(['A']);

    const down: KnowledgeSearchPort = {
      search: async () => {
        throw new Error('down');
      },
    };
    await expect(searchKnowledgeWithPlan(down, 'q', null, context)).rejects.toThrow('down');
  });
});
