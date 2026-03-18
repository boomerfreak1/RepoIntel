import { EmbeddingProvider } from "./types";
import { OllamaEmbeddingProvider } from "./ollama";

export type { EmbeddingProvider, EmbeddingResult } from "./types";
export { OllamaEmbeddingProvider } from "./ollama";

/**
 * Factory function that returns the configured embedding provider.
 * Controlled by EMBEDDING_PROVIDER env var (default: "ollama").
 *
 * To add a new provider:
 * 1. Create a new class implementing EmbeddingProvider
 * 2. Add a case to the switch below
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  const provider = process.env.EMBEDDING_PROVIDER ?? "ollama";

  switch (provider) {
    case "ollama":
      return new OllamaEmbeddingProvider();
    default:
      throw new Error(
        `Unknown embedding provider: "${provider}". Supported: ollama`
      );
  }
}
