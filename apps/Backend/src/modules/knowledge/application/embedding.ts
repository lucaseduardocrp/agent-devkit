export interface EmbeddingPort {
  embed(text: string): Promise<readonly number[]>;
}

export class DeterministicEmbedding implements EmbeddingPort {
  public embed(text: string): Promise<readonly number[]> {
    const normalized = text.trim();
    if (!normalized) {
      return Promise.reject(new Error('Text is required for embedding.'));
    }

    return Promise.resolve(
      [...normalized].slice(0, 8).map((character) => character.codePointAt(0)!),
    );
  }
}
