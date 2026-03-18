import { NextRequest } from "next/server";
import { getLatestSnapshot, getEntityStats } from "@/lib/storage";
import { getDb } from "@/lib/storage/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/summary — Document + entity focused dashboard API.
 */
export async function GET(request: NextRequest) {
  try {
    const db = getDb();

    // Documents
    const documents = db.prepare(
      "SELECT id, title, domain, format, indexed_at FROM documents ORDER BY indexed_at DESC LIMIT 10"
    ).all() as Array<{ id: number; title: string; domain: string; format: string; indexed_at: string }>;

    const documentCount = (db.prepare(
      "SELECT COUNT(*) as count FROM documents"
    ).get() as { count: number }).count;

    const domainCount = (db.prepare(
      "SELECT COUNT(DISTINCT domain) as count FROM documents WHERE domain != ''"
    ).get() as { count: number }).count;

    // Entity count
    let entityCount = 0;
    try {
      entityCount = (db.prepare(
        "SELECT COUNT(*) as count FROM entities"
      ).get() as { count: number }).count;
    } catch { /* entities table may not exist yet */ }

    // Last indexed
    const latestSnapshot = getLatestSnapshot();
    const lastIndexedAt = latestSnapshot?.created_at ?? null;

    return Response.json({
      documents,
      document_count: documentCount,
      domain_count: domainCount,
      entity_count: entityCount,
      last_indexed_at: lastIndexedAt,
    });
  } catch (error) {
    console.error("[dashboard/summary] Error:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
