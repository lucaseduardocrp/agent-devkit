import { describe, expect, it } from 'vitest';
import {
  knowledgeTitle,
  selectKnowledgeDocuments,
} from '../src/modules/knowledge/application/knowledge-selection.js';
import type { KnowledgeChunk } from '../src/modules/knowledge/domain/knowledge-chunk.js';
import { analyzeSearchPrompt } from '../src/modules/knowledge/application/search-matcher.js';

const chunk = (
  page: string,
  chunkIndex: number,
  content = 'x'.repeat(500),
  source = `app://local?title=${encodeURIComponent(page)}`,
): KnowledgeChunk => ({ source, pageId: page, chunkIndex, content, createdAt: 'now' });

const pageChunks = (page: string, count: number) =>
  Array.from({ length: count }, (_, index) => chunk(page, index));

describe('knowledgeTitle', () => {
  it('reads the title of a Brain source and falls back to the source', () => {
    expect(knowledgeTitle('app://local?title=Aprova%C3%A7%C3%A3o%20de%20Eventos')).toBe(
      'Aprovação de Eventos',
    );
    expect(knowledgeTitle('app://local?title=A+B')).toBe('A B');
    expect(knowledgeTitle('app://local?title=100%')).toBe('100%');
    expect(knowledgeTitle('https://wiki/rules')).toBe('https://wiki/rules');
    expect(knowledgeTitle('app://local?title=')).toBe('app://local?title=');
  });
});

describe('selectKnowledgeDocuments', () => {
  it('returns nothing for no chunks', () => {
    expect(selectKnowledgeDocuments([])).toEqual([]);
  });

  it('lets the other documents in even when the best page alone would fill the allowance', () => {
    const selected = selectKnowledgeDocuments([
      ...pageChunks('Aprovação de Eventos', 12),
      chunk('Aprovação — PBI 50086', 3, 'regra do PBI'),
      chunk('Fluxo de aprovação', 0, 'fluxo'),
    ]);
    expect(selected.map((document) => document.title)).toEqual([
      'Aprovação de Eventos',
      'Aprovação — PBI 50086',
      'Fluxo de aprovação',
    ]);
    expect(selected[1]?.content).toBe('regra do PBI');
  });

  it('shows more than ten chunks of one document and keeps them in reading order', () => {
    const [document] = selectKnowledgeDocuments([...pageChunks('A', 12)].reverse());
    expect(document?.content.length).toBe(12 * 500);
  });

  it('shares the character allowance between documents, then gives the rest in rank order', () => {
    const selected = selectKnowledgeDocuments(
      [...pageChunks('A', 10), ...pageChunks('B', 10)],
      { maxChars: 4000 },
    );
    expect(selected.map((document) => document.content.length)).toEqual([2000, 2000]);

    const uneven = selectKnowledgeDocuments(
      [...pageChunks('A', 10), chunk('B', 0, 'short')],
      { maxChars: 4000 },
    );
    expect(uneven[0]?.content.length).toBe(3500);
    expect(uneven[1]?.content).toBe('short');
  });

  it('marks a jump between chunks that are not neighbours', () => {
    const [document] = selectKnowledgeDocuments([
      chunk('A', 1, 'one'),
      chunk('A', 2, 'two'),
      chunk('A', 7, 'seven'),
      chunk('A', 7, 'duplicate'),
    ]);
    expect(document?.content).toBe('onetwo\n[…]\nseven');
  });

  it('limits the number of documents and always shows the first chunk of each', () => {
    const many = ['A', 'B', 'C', 'D'].map((page) => chunk(page, 0, 'x'.repeat(900)));
    expect(selectKnowledgeDocuments(many, { maxDocuments: 2 })).toHaveLength(2);
    const tight = selectKnowledgeDocuments(many, { maxChars: 1 });
    expect(tight.length).toBeGreaterThanOrEqual(1);
    expect(tight[0]?.content.length).toBe(900);
  });
});

describe('analyzeSearchPrompt for a question about a subject', () => {
  it('searches for the subject, not for the words of the question', () => {
    const analysis = analyzeSearchPrompt('O que você sabe sobre aprovação?');
    expect(analysis.cleanedPrompt).toBe('aprovação');
    expect(analysis.tokens).toEqual(['aprovação', 'aprovacao']);
    expect(analyzeSearchPrompt('Fale sobre o centro de custo.').cleanedPrompt).toBe(
      'o centro de custo',
    );
    expect(analyzeSearchPrompt('What do you know about approvals?').tokens).toEqual(['approvals']);
  });
});
