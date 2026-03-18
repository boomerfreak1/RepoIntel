/**
 * Smart retrieval strategies based on classified query intent.
 * Each strategy returns context blocks (chunks + entities) for the LLM.
 */

import { getEmbeddingProvider } from "../embeddings";
import { querySimilarChunks } from "../storage/vectorstore";
import { getDb } from "../storage/db";
import type { EntityRow } from "../storage/db";
import type { ClassifiedQuery } from "./classifier";

export interface RetrievedEntity {
  id: number;
  entity_type: string;
  content: string;
  status: string;
  owner: string | null;
  domain: string;
  source_document: string;
  relation_type?: string;
}

export interface RetrievedChunk {
  id: string;
  content: string;
  document_title: string;
  section_path: string;
  domain: string;
  distance: number;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  entities: RetrievedEntity[];
  context_text: string;
  retrieval_strategy: string;
}

/**
 * Format entities for the LLM context block.
 */
function formatEntitiesContext(entities: RetrievedEntity[]): string {
  if (entities.length === 0) return "";

  const lines = entities.map((e, i) => {
    const parts = [
      `[Entity ${i + 1}]`,
      `Type: ${e.entity_type}`,
      `Content: ${e.content}`,
      `Status: ${e.status}`,
    ];
    if (e.owner) parts.push(`Owner: ${e.owner}`);
    parts.push(`Domain: ${e.domain}`);
    parts.push(`Source: ${e.source_document}`);
    if (e.relation_type) parts.push(`Relation: ${e.relation_type}`);
    return parts.join("\n");
  });

  return `\n--- Extracted Entities ---\n${lines.join("\n\n")}`;
}

/**
 * Format chunks for the LLM context block.
 */
function formatChunksContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "";

  return chunks
    .map(
      (chunk, i) =>
        `--- Context ${i + 1} ---\nDocument: ${chunk.document_title}\nSection: ${chunk.section_path}\nDomain: ${chunk.domain}\n\n${chunk.content}`
    )
    .join("\n\n");
}

/**
 * Query entities from SQLite with joined document info.
 */
function queryEntitiesWithDocs(
  whereClause: string,
  params: unknown[],
  limit: number = 20
): RetrievedEntity[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT e.id, e.entity_type, e.content, e.status, e.owner, e.domain,
              d.path as document_path, d.title as document_title
       FROM entities e
       JOIN chunks c ON e.chunk_id = c.id
       JOIN documents d ON c.document_id = d.id
       ${whereClause}
       ORDER BY e.confidence DESC, e.first_seen_at DESC
       LIMIT ?`
    )
    .all(...params, limit) as Array<EntityRow & { document_path: string; document_title: string }>;

  return rows.map((r) => ({
    id: r.id,
    entity_type: r.entity_type,
    content: r.content,
    status: r.status,
    owner: r.owner,
    domain: r.domain,
    source_document: r.document_title ?? r.document_path,
  }));
}

/**
 * Fuzzy-match a domain name from the query against known domains in the DB.
 */
function resolveDomain(domainHint: string | null): string | null {
  if (!domainHint) return null;

  const db = getDb();
  const domains = db
    .prepare("SELECT DISTINCT domain FROM entities WHERE domain != ''")
    .all() as Array<{ domain: string }>;

  const hint = domainHint.toLowerCase().replace(/[+&]/g, "");

  // Exact match first
  for (const row of domains) {
    if (row.domain.toLowerCase() === hint) return row.domain;
  }

  // Partial match
  for (const row of domains) {
    const normalized = row.domain.toLowerCase().replace(/[+&]/g, "");
    if (normalized.includes(hint) || hint.includes(normalized)) return row.domain;
  }

  return domainHint;
}

// --- Strategy Implementations ---

/**
 * FACTUAL: Direct entity lookup using extracted filters.
 */
async function retrieveFactual(
  query: ClassifiedQuery,
  question: string
): Promise<RetrievalResult> {
  const domain = resolveDomain(query.domain);
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (domain) {
    conditions.push("e.domain = ?");
    params.push(domain);
  }
  if (query.entity_type) {
    conditions.push("e.entity_type = ?");
    params.push(query.entity_type);
  }
  if (query.stakeholder) {
    conditions.push("(e.owner LIKE ? OR e.content LIKE ?)");
    params.push(`%${query.stakeholder}%`, `%${query.stakeholder}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const entities = queryEntitiesWithDocs(where, params, 15);

  // Also get vector search results for grounding
  const embedder = getEmbeddingProvider();
  const { embedding } = await embedder.generateEmbedding(question);
  const chromaWhere = domain ? { domain } : undefined;
  const vectorChunks = await querySimilarChunks(embedding, { nResults: 3, where: chromaWhere });

  const chunks: RetrievedChunk[] = vectorChunks.map((c) => ({
    id: c.id,
    content: c.content,
    document_title: c.metadata.document_title,
    section_path: c.metadata.section_path,
    domain: c.metadata.domain,
    distance: c.distance,
  }));

  const context_text =
    formatChunksContext(chunks) + "\n\n" + formatEntitiesContext(entities);

  return { chunks, entities, context_text, retrieval_strategy: "factual" };
}

/**
 * SYNTHESIS: Vector search + entity aggregation for broad overviews.
 */
async function retrieveSynthesis(
  query: ClassifiedQuery,
  question: string
): Promise<RetrievalResult> {
  const domain = resolveDomain(query.domain);

  // Vector search, optionally filtered by domain
  const embedder = getEmbeddingProvider();
  const { embedding } = await embedder.generateEmbedding(question);
  const chromaWhere = domain ? { domain } : undefined;
  const vectorChunks = await querySimilarChunks(embedding, { nResults: 5, where: chromaWhere });

  const chunks: RetrievedChunk[] = vectorChunks.map((c) => ({
    id: c.id,
    content: c.content,
    document_title: c.metadata.document_title,
    section_path: c.metadata.section_path,
    domain: c.metadata.domain,
    distance: c.distance,
  }));

  // Pull aggregate entity data for the domain
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (domain) {
    conditions.push("e.domain = ?");
    params.push(domain);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const entities = queryEntitiesWithDocs(where, params, 20);

  // Add aggregation summary as context
  const db = getDb();
  let aggText = "";
  if (domain) {
    const agg = db
      .prepare(
        `SELECT entity_type, status, COUNT(*) as count
         FROM entities WHERE domain = ?
         GROUP BY entity_type, status ORDER BY count DESC`
      )
      .all(domain) as Array<{ entity_type: string; status: string; count: number }>;

    if (agg.length > 0) {
      aggText = `\n--- Domain Summary: ${domain} ---\n`;
      aggText += agg.map((a) => `${a.entity_type} (${a.status}): ${a.count}`).join("\n");
    }
  }

  const context_text =
    formatChunksContext(chunks) + aggText + "\n\n" + formatEntitiesContext(entities);

  return { chunks, entities, context_text, retrieval_strategy: "synthesis" };
}

/**
 * RELATIONAL: Find matching entity, traverse relations, include connected entities.
 */
async function retrieveRelational(
  query: ClassifiedQuery,
  question: string
): Promise<RetrievalResult> {
  const db = getDb();

  // Find the entity that best matches the subject using embedding similarity
  const embedder = getEmbeddingProvider();
  const { embedding: queryEmb } = await embedder.generateEmbedding(
    query.subject ?? question
  );

  // Get all entity contents and find the best match
  const allEntities = db
    .prepare(
      `SELECT e.id, e.entity_type, e.content, e.status, e.owner, e.domain, e.chunk_id,
              d.path as document_path, d.title as document_title
       FROM entities e
       JOIN chunks c ON e.chunk_id = c.id
       JOIN documents d ON c.document_id = d.id
       ORDER BY e.id`
    )
    .all() as Array<EntityRow & { document_path: string; document_title: string }>;

  // Embed entity contents and find best match
  let bestEntityIdx = -1;
  let bestSimilarity = 0;

  if (allEntities.length > 0) {
    // Embed in batches for efficiency — but limit to first 100 for speed
    const candidates = allEntities.slice(0, 100);
    const entityEmbeddings = await embedder.generateEmbeddings(
      candidates.map((e) => e.content)
    );

    for (let i = 0; i < entityEmbeddings.length; i++) {
      const emb = entityEmbeddings[i].embedding;
      let dot = 0, normA = 0, normB = 0;
      for (let j = 0; j < emb.length; j++) {
        dot += queryEmb[j] * emb[j];
        normA += queryEmb[j] * queryEmb[j];
        normB += emb[j] * emb[j];
      }
      const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestEntityIdx = i;
      }
    }
  }

  const entities: RetrievedEntity[] = [];

  if (bestEntityIdx >= 0) {
    const rootEntity = allEntities[bestEntityIdx];
    entities.push({
      id: rootEntity.id,
      entity_type: rootEntity.entity_type,
      content: rootEntity.content,
      status: rootEntity.status,
      owner: rootEntity.owner,
      domain: rootEntity.domain,
      source_document: rootEntity.document_title ?? rootEntity.document_path,
      relation_type: "root (best match)",
    });

    // Traverse relations
    const relations = db
      .prepare(
        `SELECT er.*,
                CASE WHEN er.source_entity_id = ? THEN 'outgoing' ELSE 'incoming' END as direction
         FROM entity_relations er
         WHERE er.source_entity_id = ? OR er.target_entity_id = ?`
      )
      .all(rootEntity.id, rootEntity.id, rootEntity.id) as Array<{
        source_entity_id: number;
        target_entity_id: number;
        relation_type: string;
        confidence: number;
        direction: string;
      }>;

    for (const rel of relations) {
      const connectedId =
        rel.source_entity_id === rootEntity.id
          ? rel.target_entity_id
          : rel.source_entity_id;

      const connected = db
        .prepare(
          `SELECT e.*, d.path as document_path, d.title as document_title
           FROM entities e
           JOIN chunks c ON e.chunk_id = c.id
           JOIN documents d ON c.document_id = d.id
           WHERE e.id = ?`
        )
        .get(connectedId) as (EntityRow & { document_path: string; document_title: string }) | undefined;

      if (connected) {
        entities.push({
          id: connected.id,
          entity_type: connected.entity_type,
          content: connected.content,
          status: connected.status,
          owner: connected.owner,
          domain: connected.domain,
          source_document: connected.document_title ?? connected.document_path,
          relation_type: `${rel.relation_type} (${rel.direction})`,
        });
      }
    }
  }

  // Also get vector search for broader context
  const vectorChunks = await querySimilarChunks(queryEmb, { nResults: 3 });
  const chunks: RetrievedChunk[] = vectorChunks.map((c) => ({
    id: c.id,
    content: c.content,
    document_title: c.metadata.document_title,
    section_path: c.metadata.section_path,
    domain: c.metadata.domain,
    distance: c.distance,
  }));

  const context_text =
    formatChunksContext(chunks) + "\n\n" + formatEntitiesContext(entities);

  return { chunks, entities, context_text, retrieval_strategy: "relational" };
}

/**
 * EXPLORATORY: Surface issues, open gaps, stale items, unowned dependencies.
 */
async function retrieveExploratory(
  query: ClassifiedQuery,
  question: string
): Promise<RetrievalResult> {
  const db = getDb();

  // Open and blocked entities
  const openBlocked = queryEntitiesWithDocs(
    "WHERE e.status IN ('open', 'blocked')",
    [],
    15
  );

  // Stale gaps (open > 14 days)
  const staleGaps = queryEntitiesWithDocs(
    "WHERE e.entity_type = 'gap' AND e.status = 'open' AND e.first_seen_at <= datetime('now', '-14 days')",
    [],
    10
  );

  // Unowned dependencies
  const unownedDeps = queryEntitiesWithDocs(
    "WHERE e.entity_type = 'dependency' AND e.owner IS NULL",
    [],
    10
  );

  // Deduplicate by id
  const seen = new Set<number>();
  const entities: RetrievedEntity[] = [];

  for (const group of [
    { items: staleGaps, label: "stale gap (>14 days)" },
    { items: unownedDeps, label: "unowned dependency" },
    { items: openBlocked, label: "" },
  ]) {
    for (const e of group.items) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        entities.push({
          ...e,
          relation_type: group.label || undefined,
        });
      }
    }
  }

  // Light vector search for additional context
  const embedder = getEmbeddingProvider();
  const { embedding } = await embedder.generateEmbedding(question);
  const vectorChunks = await querySimilarChunks(embedding, { nResults: 3 });

  const chunks: RetrievedChunk[] = vectorChunks.map((c) => ({
    id: c.id,
    content: c.content,
    document_title: c.metadata.document_title,
    section_path: c.metadata.section_path,
    domain: c.metadata.domain,
    distance: c.distance,
  }));

  const context_text =
    formatChunksContext(chunks) + "\n\n" + formatEntitiesContext(entities);

  return { chunks, entities, context_text, retrieval_strategy: "exploratory" };
}

/**
 * Main retrieval entry point — dispatches to the correct strategy.
 */
export async function retrieve(
  classification: ClassifiedQuery,
  question: string
): Promise<RetrievalResult> {
  switch (classification.intent) {
    case "factual":
      return retrieveFactual(classification, question);
    case "synthesis":
      return retrieveSynthesis(classification, question);
    case "relational":
      return retrieveRelational(classification, question);
    case "exploratory":
      return retrieveExploratory(classification, question);
    default:
      return retrieveSynthesis(classification, question);
  }
}
