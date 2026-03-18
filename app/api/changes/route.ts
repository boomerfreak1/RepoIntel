import { NextRequest } from "next/server";
import { getLatestSnapshot } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * GET /api/changes — Returns the change delta from the most recent index snapshot.
 */
export async function GET(request: NextRequest) {
  try {
    const snapshot = getLatestSnapshot();

    if (!snapshot) {
      return new Response(
        JSON.stringify({ error: "No index snapshots found. Run the indexing pipeline first." }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    const changeDelta = snapshot.change_delta
      ? JSON.parse(snapshot.change_delta)
      : null;

    const entitySummary = snapshot.entity_summary
      ? JSON.parse(snapshot.entity_summary)
      : null;

    return new Response(
      JSON.stringify({
        snapshot_id: snapshot.id,
        created_at: snapshot.created_at,
        github_sha: snapshot.github_sha,
        entity_summary: entitySummary,
        change_delta: changeDelta,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[changes] Error:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
