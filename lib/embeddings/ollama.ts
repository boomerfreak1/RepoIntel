import { EmbeddingProvider, EmbeddingResult } from "./types";

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_MODEL = "nomic-embed-text";

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private baseUrl: string;
  private model: string;

  constructor(options?: { baseUrl?: string; model?: string }) {
    this.baseUrl =
      options?.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL;
    this.model = options?.model ?? DEFAULT_MODEL;
  }

  async generateEmbedding(text: string): Promise<EmbeddingResult> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt: text,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Ollama embedding error ${response.status}: ${body}`
      );
    }

    const data = (await response.json()) as { embedding: number[] };

    return {
      embedding: data.embedding,
      model: this.model,
    };
  }

  async generateEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
    // Ollama doesn't have a native batch endpoint, so we run sequentially
    const results: EmbeddingResult[] = [];
    for (const text of texts) {
      results.push(await this.generateEmbedding(text));
    }
    return results;
  }

  async healthCheck(): Promise<{
    available: boolean;
    provider: string;
    model: string;
    error?: string;
  }> {
    try {
      // Check if Ollama is running
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        return {
          available: false,
          provider: "ollama",
          model: this.model,
          error: `Ollama returned status ${response.status}`,
        };
      }

      const data = (await response.json()) as {
        models: Array<{ name: string }>;
      };
      const modelNames = data.models.map((m) => m.name);

      // Check if the required model is available (handle tag suffix)
      const modelAvailable = modelNames.some(
        (name) =>
          name === this.model || name.startsWith(`${this.model}:`)
      );

      if (!modelAvailable) {
        return {
          available: false,
          provider: "ollama",
          model: this.model,
          error: `Model "${this.model}" not found. Available models: ${modelNames.join(", ") || "none"}. Run: ollama pull ${this.model}`,
        };
      }

      return {
        available: true,
        provider: "ollama",
        model: this.model,
      };
    } catch (error) {
      return {
        available: false,
        provider: "ollama",
        model: this.model,
        error:
          error instanceof Error
            ? `Cannot connect to Ollama at ${this.baseUrl}: ${error.message}`
            : String(error),
      };
    }
  }
}
