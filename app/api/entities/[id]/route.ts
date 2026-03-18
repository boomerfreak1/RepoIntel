import { NextRequest } from "next/server";
import { getEntityById, getEntityRelations, getChunkById } from "@/lib/storage";

/**
 * GET /api/entities/[id] — Get a single entity with its relations and source chunk.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const entityId = parseInt(id, 10);

    if (isNaN(entityId)) {
      return new Response(
        JSON.stringify({ error: "Invalid entity ID" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const entity = getEntityById(entityId);
    if (!entity) {
      return new Response(
        JSON.stringify({ error: "Entity not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    const relations = getEntityRelations(entityId);
    const sourceChunk = getChunkById(entity.chunk_id);

    return new Response(
      JSON.stringify({
        entity,
        relations,
        source_chunk: sourceChunk
          ? {
              id: sourceChunk.id,
              content: sourceChunk.content,
              section_path: sourceChunk.section_path,
              section_title: sourceChunk.section_title,
            }
          : null,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[entities] Error:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
