/**
 * Semantic change detection for entity evolution tracking.
 * Compares new entities against a previous entity snapshot using
 * cosine similarity on embeddings from Ollama nomic-embed-text.
 */

import { getEmbeddingProvider } from "../embeddings";
import type { EntityRow } from "../storage/db";

const SIMILARITY_THRESHOLD = 0.85;

export type ChangeCategory = "new" | "resolved" | "modified" | "unchanged";

export interface ChangeEntry {
  entity_id: number;
  entity_type: string;
  content: string;
  domain: string;
  status: string;
  owner: string | null;
  source_document: string;
  change_category: ChangeCategory;
  previous_content?: string;
  previous_status?: string;
  previous_owner?: string | null;
  similarity_score?: number;
}

export interface ChangeDelta {
  summary: {
    new: number;
    resolved: number;
    modified: number;
    unchanged: number;
    total: number;
  };
  changes: ChangeEntry[];
}

/**
 * Saved entity from before clearAll — includes document path
 * so we can reference source documents in the change delta.
 */
export interface PreviousEntity {
  id: number;
  entity_type: string;
  content: string;
  status: string;
  owner: string | null;
  domain: string;
  document_path: string;
  embedding?: number[];
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Batch-embed entity content strings. Processes in batches to avoid
 * overwhelming Ollama with hundreds of sequential requests.
 */
async function embedEntityContents(contents: string[]): Promise<number[][]> {
  if (contents.length === 0) return [];

  const embedder = getEmbeddingProvider();
  const embeddings: number[][] = [];

  // Process in batches of 20 to keep memory manageable
  const BATCH_SIZE = 20;
  for (let i = 0; i < contents.length; i += BATCH_SIZE) {
    const batch = contents.slice(i, i + BATCH_SIZE);
    const results = await embedder.generateEmbeddings(batch);
    for (const result of results) {
      embeddings.push(result.embedding);
    }
  }

  return embeddings;
}

/**
 * Find the best semantic match for a new entity among previous entities.
 * Returns the matched previous entity and similarity score, or null if no match above threshold.
 */
function findBestMatch(
  newEmbedding: number[],
  previousEntities: PreviousEntity[],
  previousEmbeddings: number[][],
  matchedIndices: Set<number>
): { index: number; similarity: number } | null {
  let bestIndex = -1;
  let bestSimilarity = 0;

  for (let i = 0; i < previousEntities.length; i++) {
    if (matchedIndices.has(i)) continue;

    const similarity = cosineSimilarity(newEmbedding, previousEmbeddings[i]);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestIndex = i;
    }
  }

  if (bestIndex >= 0 && bestSimilarity >= SIMILARITY_THRESHOLD) {
    return { index: bestIndex, similarity: bestSimilarity };
  }

  return null;
}

/**
 * Compute the change delta between new entities and previous entities.
 * Uses semantic similarity via embeddings for entity matching.
 *
 * @param newEntities - Current entities after re-indexing (with DB IDs)
 * @param newDocumentPaths - Map of chunk_id -> document_path for new entities
 * @param previousEntities - Entities captured before clearAll
 * @returns ChangeDelta with classified changes
 */
export async function computeChangeDelta(
  newEntities: EntityRow[],
  newDocumentPaths: Map<string, string>,
  previousEntities: PreviousEntity[]
): Promise<ChangeDelta> {
  // If no previous entities, everything is new
  if (previousEntities.length === 0) {
    const changes: ChangeEntry[] = newEntities.map((e) => ({
      entity_id: e.id,
      entity_type: e.entity_type,
      content: e.content,
      domain: e.domain,
      status: e.status,
      owner: e.owner,
      source_document: newDocumentPaths.get(e.chunk_id) ?? "unknown",
      change_category: "new" as ChangeCategory,
    }));

    return {
      summary: {
        new: changes.length,
        resolved: 0,
        modified: 0,
        unchanged: 0,
        total: changes.length,
      },
      changes,
    };
  }

  console.log(`[differ] Comparing ${newEntities.length} new entities against ${previousEntities.length} previous entities`);

  // Embed all entity content strings
  const allContents = [
    ...newEntities.map((e) => e.content),
    ...previousEntities.map((e) => e.content),
  ];

  let allEmbeddings: number[][];
  try {
    allEmbeddings = await embedEntityContents(allContents);
  } catch (error) {
    console.error("[differ] Embedding failed, falling back to all-new classification:", error instanceof Error ? error.message : error);
    // Fallback: treat everything as new if embedding fails
    const changes: ChangeEntry[] = newEntities.map((e) => ({
      entity_id: e.id,
      entity_type: e.entity_type,
      content: e.content,
      domain: e.domain,
      status: e.status,
      owner: e.owner,
      source_document: newDocumentPaths.get(e.chunk_id) ?? "unknown",
      change_category: "new" as ChangeCategory,
    }));
    return {
      summary: { new: changes.length, resolved: 0, modified: 0, unchanged: 0, total: changes.length },
      changes,
    };
  }

  const newEmbeddings = allEmbeddings.slice(0, newEntities.length);
  const prevEmbeddings = allEmbeddings.slice(newEntities.length);

  // Match new entities to previous entities
  const matchedPrevIndices = new Set<number>();
  const changes: ChangeEntry[] = [];

  for (let i = 0; i < newEntities.length; i++) {
    const entity = newEntities[i];
    const match = findBestMatch(newEmbeddings[i], previousEntities, prevEmbeddings, matchedPrevIndices);

    if (!match) {
      // No match found — this is a new entity
      changes.push({
        entity_id: entity.id,
        entity_type: entity.entity_type,
        content: entity.content,
        domain: entity.domain,
        status: entity.status,
        owner: entity.owner,
        source_document: newDocumentPaths.get(entity.chunk_id) ?? "unknown",
        change_category: "new",
      });
    } else {
      matchedPrevIndices.add(match.index);
      const prev = previousEntities[match.index];

      // Check if anything changed
      const statusChanged = entity.status !== prev.status;
      const ownerChanged = entity.owner !== prev.owner;
      const contentChanged = match.similarity < 0.98; // Near-identical but not exact

      if (statusChanged || ownerChanged || contentChanged) {
        changes.push({
          entity_id: entity.id,
          entity_type: entity.entity_type,
          content: entity.content,
          domain: entity.domain,
          status: entity.status,
          owner: entity.owner,
          source_document: newDocumentPaths.get(entity.chunk_id) ?? "unknown",
          change_category: "modified",
          previous_content: prev.content,
          previous_status: prev.status,
          previous_owner: prev.owner,
          similarity_score: Math.round(match.similarity * 1000) / 1000,
        });
      } else {
        changes.push({
          entity_id: entity.id,
          entity_type: entity.entity_type,
          content: entity.content,
          domain: entity.domain,
          status: entity.status,
          owner: entity.owner,
          source_document: newDocumentPaths.get(entity.chunk_id) ?? "unknown",
          change_category: "unchanged",
          similarity_score: Math.round(match.similarity * 1000) / 1000,
        });
      }
    }
  }

  // Previous entities that weren't matched are "resolved" (no longer present)
  for (let i = 0; i < previousEntities.length; i++) {
    if (!matchedPrevIndices.has(i)) {
      const prev = previousEntities[i];
      changes.push({
        entity_id: prev.id,
        entity_type: prev.entity_type,
        content: prev.content,
        domain: prev.domain,
        status: prev.status,
        owner: prev.owner,
        source_document: prev.document_path,
        change_category: "resolved",
      });
    }
  }

  const summary = {
    new: changes.filter((c) => c.change_category === "new").length,
    resolved: changes.filter((c) => c.change_category === "resolved").length,
    modified: changes.filter((c) => c.change_category === "modified").length,
    unchanged: changes.filter((c) => c.change_category === "unchanged").length,
    total: changes.length,
  };

  console.log(`[differ] Change delta: ${summary.new} new, ${summary.resolved} resolved, ${summary.modified} modified, ${summary.unchanged} unchanged`);

  return { summary, changes };
}
