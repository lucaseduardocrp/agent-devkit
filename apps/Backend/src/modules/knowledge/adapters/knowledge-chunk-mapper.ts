import { ApplicationError } from '../../../shared/errors.js';
import type { KnowledgeChunk } from '../domain/knowledge-chunk.js';

export interface KnowledgeChunkRecordData {
  readonly ownerId: string;
  readonly source: string;
  readonly pageId: string;
  readonly chunkIndex: number;
  readonly content: string;
  readonly createdAt: Date;
}

export function toKnowledgeChunk(record: KnowledgeChunkRecordData): KnowledgeChunk {
  if (Number.isNaN(record.createdAt.getTime())) {
    throw invalidChunkError();
  }
  return {
    source: record.source,
    pageId: record.pageId,
    chunkIndex: record.chunkIndex,
    content: record.content,
    createdAt: record.createdAt.toISOString(),
  };
}

export function toKnowledgeChunkRecord(
  chunk: KnowledgeChunk,
  ownerId: string,
): KnowledgeChunkRecordData {
  const createdAt = new Date(chunk.createdAt);
  if (
    !chunk.source.trim() ||
    !chunk.pageId.trim() ||
    chunk.chunkIndex < 0 ||
    !Number.isInteger(chunk.chunkIndex) ||
    !chunk.content ||
    Number.isNaN(createdAt.getTime())
  ) {
    throw invalidChunkError();
  }
  return { ownerId, ...chunk, createdAt };
}

function invalidChunkError(): ApplicationError {
  return new ApplicationError(
    'INVALID_KNOWLEDGE_CHUNK',
    'Knowledge chunk contains invalid data.',
    400,
  );
}
