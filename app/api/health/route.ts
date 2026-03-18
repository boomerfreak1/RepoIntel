import { NextResponse } from "next/server";
import { getEmbeddingProvider } from "@/lib/embeddings";
import { chromaHealthCheck, getCollectionStats } from "@/lib/storage/vectorstore";
import { getStats, dbHealthCheck } from "@/lib/storage/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — comprehensive health check.
 * Adapts to AI_MODE (local vs cloud).
 */
export async function GET() {
  const timestamp = new Date().toISOString();
  const aiMode = process.env.AI_MODE ?? "local";

  // 1. Next.js server is running (if we got here, it is)
  const server = true;

  // 2. Embedding provider check
  let embeddings = false;
  let embeddingModel = "";
  let embeddingError = "";

  if (aiMode === "local") {
    try {
      const provider = getEmbeddingProvider();
      const check = await provider.healthCheck();
      embeddings = check.available;
      embeddingModel = check.model ?? "";
      if (check.error) embeddingError = check.error;
    } catch (error) {
      embeddingError = error instanceof Error ? error.message : String(error);
    }
  } else {
    // In cloud mode, check if API keys are configured
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    const hasMistral = !!process.env.MISTRAL_API_KEY;
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    embeddings = hasOpenAI || hasMistral;
    embeddingModel = hasOpenAI ? "openai" : hasMistral ? "mistral" : "none";
    if (!embeddings) embeddingError = "No OPENAI_API_KEY or MISTRAL_API_KEY configured for cloud mode";
  }

  // 3. SQLite database is accessible
  let sqlite = false;
  let sqlitePath = "";
  let sqliteError = "";
  try {
    const check = dbHealthCheck();
    sqlite = check.available;
    sqlitePath = check.path;
    if (check.error) sqliteError = check.error;
  } catch (error) {
    sqliteError = error instanceof Error ? error.message : String(error);
  }

  // 4. ChromaDB is accessible
  let chromadb = false;
  let chromaError = "";
  try {
    const check = await chromaHealthCheck();
    chromadb = check.available;
    if (check.error) chromaError = check.error;
  } catch (error) {
    chromaError = error instanceof Error ? error.message : String(error);
  }

  // 5. GitHub API connection
  let github = false;
  let githubRepo = "";
  let githubError = "";
  const githubToken = process.env.GITHUB_TOKEN;
  const githubRepoEnv = process.env.GITHUB_REPO;

  if (githubToken && githubRepoEnv) {
    try {
      const { GitHubClient } = await import("@/lib/github");
      const client = new GitHubClient({
        token: githubToken,
        repo: githubRepoEnv,
      });
      const check = await client.healthCheck();
      github = check.connected;
      githubRepo = check.repo;
      if (check.error) githubError = check.error;
    } catch (error) {
      githubError = error instanceof Error ? error.message : String(error);
    }
  } else {
    githubError = "GITHUB_TOKEN or GITHUB_REPO not configured";
  }

  // 6. Chat model availability
  let chatModel = false;
  let chatModelName = "";
  let chatModelError = "";

  if (aiMode === "local") {
    chatModelName = process.env.OLLAMA_CHAT_MODEL ?? "llama3.2:1b";
    try {
      const ollamaBase = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
      const tagsRes = await fetch(`${ollamaBase}/api/tags`);
      if (tagsRes.ok) {
        const tagsData = await tagsRes.json();
        const models = (tagsData.models ?? []) as Array<{ name: string }>;
        chatModel = models.some((m) => m.name.startsWith(chatModelName.split(":")[0]));
        if (!chatModel) chatModelError = `${chatModelName} not found in Ollama`;
      } else {
        chatModelError = `Ollama tags API returned ${tagsRes.status}`;
      }
    } catch (error) {
      chatModelError = error instanceof Error ? error.message : String(error);
    }
  } else {
    const hasMistral = !!process.env.MISTRAL_API_KEY;
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    chatModel = hasMistral || hasAnthropic || hasOpenAI;
    chatModelName = hasMistral ? "mistral" : hasAnthropic ? "claude" : hasOpenAI ? "openai" : "none";
    if (!chatModel) chatModelError = "No cloud API key configured (MISTRAL_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY)";
  }

  // Index stats
  let indexStats = { documents: 0, chunks: 0, totalTokens: 0, vectorCount: 0 };
  try {
    const dbStats = getStats();
    const vectorStats = await getCollectionStats();
    indexStats = {
      documents: dbStats.documentCount,
      chunks: dbStats.chunkCount,
      totalTokens: dbStats.totalTokens,
      vectorCount: vectorStats.count,
    };
  } catch {
    // Stats unavailable, keep defaults
  }

  const allHealthy = server && embeddings && sqlite && chromadb && github && chatModel;

  return NextResponse.json({
    status: allHealthy ? "healthy" : "degraded",
    timestamp,
    ai_mode: aiMode,
    checks: {
      server,
      embeddings,
      sqlite,
      chromadb,
      github,
      chatModel,
    },
    details: {
      embeddings: {
        model: embeddingModel,
        ...(embeddingError && { error: embeddingError }),
      },
      chatModel: {
        model: chatModelName,
        ...(chatModelError && { error: chatModelError }),
      },
      sqlite: {
        path: sqlitePath,
        ...(sqliteError && { error: sqliteError }),
      },
      chromadb: {
        ...(chromaError && { error: chromaError }),
      },
      github: {
        repo: githubRepo,
        ...(githubError && { error: githubError }),
      },
    },
    index: indexStats,
  });
}
