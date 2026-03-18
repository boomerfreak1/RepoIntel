import { NextRequest } from "next/server";
import { getRecentSnapshots } from "@/lib/storage";

/**
 * GET /api/changes/history — Returns change deltas across the last N index snapshots.
 * Query params: limit (default 10)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 10, 1), 50) : 10;

    const snapshots = getRecentSnapshots(limit);

    const history = snapshots.map((snapshot) => ({
      snapshot_id: snapshot.id,
      created_at: snapshot.created_at,
      github_sha: snapshot.github_sha,
      entity_summary: snapshot.entity_summary
        ? JSON.parse(snapshot.entity_summary)
        : null,
      change_delta: snapshot.change_delta
        ? JSON.parse(snapshot.change_delta)
        : null,
    }));

    return new Response(
      JSON.stringify({ snapshots: history, count: history.length }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[changes/history] Error:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
