/**
 * Embedding provider interface.
 * Implementations can be swapped by changing EMBEDDING_PROVIDER env var.
 */

export interface EmbeddingResult {
  embedding: number[];
  model: string;
}

export interface EmbeddingProvider {
  /** Generate an embedding vector for the given text. */
  generateEmbedding(text: string): Promise<EmbeddingResult>;

  /** Generate embeddings for multiple texts in batch. */
  generateEmbeddings(texts: string[]): Promise<EmbeddingResult[]>;

  /** Check if the provider is available and the model is loaded. */
  healthCheck(): Promise<{
    available: boolean;
    provider: string;
    model: string;
    error?: string;
  }>;
}
