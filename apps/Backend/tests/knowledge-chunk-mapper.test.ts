import { describe, expect, it } from 'vitest';
import {
  toKnowledgeChunk,
  toKnowledgeChunkRecord,
} from '../src/modules/knowledge/adapters/knowledge-chunk-mapper.js';

const chunk = {
  source: 'wiki',
  pageId: 'page-1',
  chunkIndex: 0,
  content: 'content',
  createdAt: '2026-09-11T10:00:00.000Z',
};

describe('knowledge chunk mapper', () => {
  it('maps domain values to records and back with ISO timestamps', () => {
    const record = toKnowledgeChunkRecord(chunk, 'owner-1');
    expect(record).toEqual({ ...chunk, ownerId: 'owner-1', createdAt: new Date(chunk.createdAt) });
    expect(toKnowledgeChunk(record)).toEqual(chunk);
  });

  it.each([
    { ...chunk, source: ' ' },
    { ...chunk, pageId: ' ' },
    { ...chunk, chunkIndex: -1 },
    { ...chunk, chunkIndex: 0.5 },
    { ...chunk, content: '' },
    { ...chunk, createdAt: 'not-a-date' },
  ])('rejects invalid domain records %#', (invalidChunk) => {
    expect(() => toKnowledgeChunkRecord(invalidChunk, 'owner-1')).toThrow(
      'Knowledge chunk contains invalid data.',
    );
  });

  it('rejects invalid persistence timestamps', () => {
    expect(() =>
      toKnowledgeChunk({
        ownerId: 'owner-1',
        ...chunk,
        createdAt: new Date('invalid'),
      }),
    ).toThrow('Knowledge chunk contains invalid data.');
  });
});
