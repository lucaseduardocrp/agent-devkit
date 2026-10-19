export interface KnowledgeChunk {
  readonly source: string;
  readonly pageId: string;
  readonly chunkIndex: number;
  readonly content: string;
  readonly createdAt: string;
}
