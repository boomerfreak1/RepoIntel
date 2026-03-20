import { extractEntities } from "@/lib/ai";
import { getEntityStats } from "@/lib/storage";

export const dynamic = "force-dynamic";

const TEST_TEXT = `The team decided to migrate from REST to GraphQL for better query flexibility. Sarah Chen will lead the migration effort. We still need to figure out who owns the authentication service migration. The deployment pipeline depends on the CI/CD system passing all integration tests. The timeline for the API v2 rollout hasn't been established yet.`;

/**
 * GET /api/debug — Test extraction pipeline and show entity stats.
 * Hit this endpoint after deploying to verify extraction works.
 */
export async function GET() {
  const stats = getEntityStats();

  const aiMode = process.env.AI_MODE ?? "local";
  const mistralKey = process.env.MISTRAL_API_KEY;
  const mistralModel = process.env.MISTRAL_MODEL ?? "mistral-small-latest";

  let extractionResult: { entities: unknown[]; error?: string } = { entities: [] };
  try {
    const entities = await extractEntities(TEST_TEXT);
    extractionResult = { entities };
  } catch (error) {
    extractionResult = {
      entities: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return Response.json({
    ai_mode: aiMode,
    db_entity_stats: stats,
    mistral_configured: !!mistralKey,
    mistral_model: mistralModel,
    test_extraction: extractionResult,
  });
}
