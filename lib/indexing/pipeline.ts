import fs from "fs";
import { GitHubClient, getGitHubClient } from "../github";
import { parseDocument, isSupported } from "../parsers";
import { chunkDocument, Chunk } from "./chunker";
import { getEmbeddingProvider } from "../embeddings";
import {
  upsertDocument,
  insertChunks,
  deleteChunksByDocumentId,
  getDocumentByPath,
  getAllDocuments,
  getStats,
  clearAll,
  addChunks as addVectorChunks,
  deleteDocumentChunks,
  resetCollection,
  deleteDocument,
  createIndexSnapshot,
  insertEntities,
  insertEntityRelations,
  deleteEntitiesByDocumentId,
  getEntities,
  getEntitiesWithDocumentPath,
  getChunkDocumentPathMap,
  updateSnapshotChangeDelta,
} from "../storage";
import type { EntityRow } from "../storage";
import { extractEntitiesBatch, extractRelations } from "../ai/extractor";
import type { ExtractedEntity, ExtractedRelation } from "../ai/extractor";
import { computeChangeDelta, PreviousEntity } from "./differ";

/**
 * Full indexing pipeline: GitHub -> Parse -> Chunk -> Embed -> Store.
 */

const DEFAULT_DATA_DIR = process.env.NODE_ENV === "production" ? "/data" : "./data";

/**
 * Ensure the data directory exists (handles fresh persistent volumes on first deploy).
 */
function ensureDataDir(): void {
  const dataDir = process.env.DATA_DIR ?? DEFAULT_DATA_DIR;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(`${dataDir}/chroma`, { recursive: true });
}

/**
 * Check if the index is empty (first deploy / fresh volume).
 */
export function isIndexEmpty(): boolean {
  try {
    const stats = getStats();
    return stats.documentCount === 0;
  } catch {
    return true;
  }
}

export interface IndexProgress {
  phase: string;
  current: number;
  total: number;
  message: string;
}

export type ProgressCallback = (progress: IndexProgress) => void;

export interface IndexResult {
  documentsProcessed: number;
  chunksCreated: number;
  entitiesExtracted: number;
  relationsExtracted: number;
  errors: Array<{ file: string; error: string }>;
  duration: number;
}

/**
 * Infer domain from file path.
 * Uses configurable PROJECT_DOMAINS env var, or falls back to folder-based inference.
 */
function inferDomain(filePath: string): string {
  const fileName = filePath.split("/").pop() ?? "";
  const filePathLower = filePath.toLowerCase();

  // If PROJECT_DOMAINS is configured, try to match against those
  const configuredDomains = process.env.PROJECT_DOMAINS;
  if (configuredDomains) {
    try {
      const domains = JSON.parse(configuredDomains) as string[];
      for (const domain of domains) {
        if (filePathLower.includes(domain.toLowerCase())) {
          return domain;
        }
      }
    } catch {
      console.warn("[index] Invalid PROJECT_DOMAINS JSON, falling back to folder-based inference");
    }
  }

  // Use parent folder as domain
  const parts = filePath.split("/");
  if (parts.length > 1) return parts[0];

  return "general";
}

/**
 * Run the full indexing pipeline.
 * Pulls all supported files from GitHub, parses, chunks, embeds, and stores.
 */
export async function runFullIndex(
  onProgress?: ProgressCallback,
  options?: { force?: boolean }
): Promise<IndexResult> {
  const startTime = Date.now();
  const errors: Array<{ file: string; error: string }> = [];
  let documentsProcessed = 0;
  let chunksCreated = 0;
  let entitiesExtracted = 0;
  let relationsExtracted = 0;

  const progress = (phase: string, current: number, total: number, message: string) => {
    onProgress?.({ phase, current, total, message });
  };

  // Step 0: Ensure data directory exists (fresh deploy)
  ensureDataDir();

  // Step 1: List files from GitHub
  progress("fetch", 0, 1, "Connecting to GitHub...");
  const github = getGitHubClient();
  const allFiles = await github.listFiles();
  const supportedFiles = allFiles.filter((f) => isSupported(f.path));

  progress(
    "fetch",
    1,
    1,
    `Found ${supportedFiles.length} supported files out of ${allFiles.length} total`
  );

  const forceFullReindex = options?.force ?? false;

  // Step 2: Determine which files need processing
  progress("prepare", 0, 1, "Comparing files against existing index...");

  // Snapshot previous entities before clearing (for change delta on force re-index)
  let previousEntities: PreviousEntity[] = [];
  if (forceFullReindex) {
    progress("prepare", 0, 1, "Force mode: snapshotting previous entities...");
    try {
      const prevRows = getEntitiesWithDocumentPath();
      previousEntities = prevRows.map((e) => ({
        id: e.id,
        entity_type: e.entity_type,
        content: e.content,
        status: e.status,
        owner: e.owner,
        domain: e.domain,
        document_path: e.document_path,
      }));
      console.log(`[index] Captured ${previousEntities.length} previous entities for change delta`);
    } catch (err) {
      console.warn("[index] Failed to snapshot previous entities:", err instanceof Error ? err.message : err);
    }

    progress("prepare", 0, 1, "Force mode: clearing existing index...");
    clearAll();
    await resetCollection();
    progress("prepare", 1, 1, "Index cleared");
  }

  // SHA-based incremental: determine which files changed
  const githubPaths = new Set(supportedFiles.map((f) => f.path));
  const existingDocs = forceFullReindex ? [] : getAllDocuments();
  const existingByPath = new Map(existingDocs.map((d) => [d.path, d]));

  // Files to process: new or changed SHA
  const filesToProcess = supportedFiles.filter((f) => {
    if (forceFullReindex) return true;
    const existing = existingByPath.get(f.path);
    if (!existing) return true; // new file
    return existing.sha !== f.sha; // SHA changed
  });

  // Files removed from GitHub: delete their data
  if (!forceFullReindex) {
    const removedDocs = existingDocs.filter((d) => !githubPaths.has(d.path));
    for (const doc of removedDocs) {
      console.log(`[index] Removing deleted file: ${doc.path}`);
      deleteEntitiesByDocumentId(doc.id);
      deleteChunksByDocumentId(doc.id);
      await deleteDocumentChunks(doc.path);
      deleteDocument(doc.path);
    }

    // Clean old data for files being reprocessed
    for (const file of filesToProcess) {
      const existing = existingByPath.get(file.path);
      if (existing) {
        deleteEntitiesByDocumentId(existing.id);
        deleteChunksByDocumentId(existing.id);
        await deleteDocumentChunks(existing.path);
      }
    }
  }

  const skippedCount = supportedFiles.length - filesToProcess.length;
  console.log(`[index] ${filesToProcess.length} files to process, ${skippedCount} unchanged (skipped)`);
  progress(
    "prepare",
    1,
    1,
    `${filesToProcess.length} files to process, ${skippedCount} unchanged`
  );

  const embedder = getEmbeddingProvider();

  // Track chunks per document for extraction
  const docChunksMap = new Map<string, { chunks: Chunk[]; domain: string; docId: number }>();

  // Step 3: Fetch, parse, chunk, embed changed files
  for (let i = 0; i < filesToProcess.length; i++) {
    const file = filesToProcess[i];
    progress(
      "parse",
      i,
      filesToProcess.length,
      `Parsing & embedding: ${file.path.split("/").pop()}`
    );

    try {
      const rawUrl = `https://raw.githubusercontent.com/${process.env.GITHUB_REPO}/main/${file.path}`;
      const response = await fetch(rawUrl, {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} fetching ${file.path}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const parsed = await parseDocument(buffer, file.path);
      const chunks = chunkDocument(parsed);
      const domain = inferDomain(file.path);

      const docRow = upsertDocument({
        path: file.path,
        title: parsed.title,
        format: parsed.format,
        sha: file.sha,
        size_bytes: file.size,
        domain,
        chunk_count: chunks.length,
      });

      insertChunks(
        chunks.map((c) => ({
          id: c.id,
          document_id: docRow.id,
          chunk_index: c.chunkIndex,
          content: c.content,
          section_path: c.sectionPath,
          section_title: c.sectionTitle,
          token_estimate: c.tokenEstimate,
        }))
      );

      progress(
        "embed",
        i,
        filesToProcess.length,
        `Embedding ${chunks.length} chunks from ${file.path.split("/").pop()}`
      );

      const embeddings = await embedder.generateEmbeddings(
        chunks.map((c) => c.content)
      );

      await addVectorChunks(
        chunks.map((c, j) => ({
          id: c.id,
          content: c.content,
          embedding: embeddings[j].embedding,
          metadata: {
            document_id: String(docRow.id),
            document_path: c.documentPath,
            document_title: c.documentTitle,
            doc_type: c.format,
            domain,
            section_path: c.sectionPath,
            section_title: c.sectionTitle,
            chunk_index: c.chunkIndex,
            token_estimate: c.tokenEstimate,
          },
        }))
      );

      // Save chunks for entity extraction
      docChunksMap.set(file.path, { chunks, domain, docId: docRow.id });

      chunksCreated += chunks.length;
      documentsProcessed++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[index] Error processing ${file.path}:`, msg);
      errors.push({ file: file.path, error: msg });
    }
  }

  // Step 4: Entity extraction — runs after all chunks are embedded
  progress("extract", 0, documentsProcessed, "Starting entity extraction...");

  // Collect all chunks for batch extraction
  const allChunksForExtraction: Array<{ content: string; tokenEstimate: number; chunkId: string; domain: string }> = [];
  for (const [filePath, { chunks, domain }] of docChunksMap) {
    for (const chunk of chunks) {
      allChunksForExtraction.push({
        content: chunk.content,
        tokenEstimate: chunk.tokenEstimate,
        chunkId: chunk.id,
        domain,
      });
    }
  }

  try {
    const entityMap = await extractEntitiesBatch(
      allChunksForExtraction.map((c) => ({ content: c.content, tokenEstimate: c.tokenEstimate })),
      (processed, total) => {
        progress("extract", processed, total, `Extracting entities: ${processed}/${total} chunks`);
      }
    );

    // Store extracted entities per chunk
    for (const [chunkIdx, entities] of entityMap) {
      if (entities.length === 0) continue;
      const chunkInfo = allChunksForExtraction[chunkIdx];
      try {
        insertEntities(
          entities.map((e) => ({
            chunk_id: chunkInfo.chunkId,
            entity_type: e.entity_type,
            content: e.content,
            status: e.status,
            owner: e.owner,
            domain: chunkInfo.domain,
            confidence: e.confidence,
          }))
        );
        entitiesExtracted += entities.length;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[index] Failed to store entities for chunk ${chunkInfo.chunkId}:`, msg);
        errors.push({ file: chunkInfo.chunkId, error: `Entity storage: ${msg}` });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[index] Entity extraction failed:", msg);
    errors.push({ file: "(entity-extraction)", error: msg });
  }

  progress("extract", documentsProcessed, documentsProcessed, `Extracted ${entitiesExtracted} entities`);

  // Step 5: Relation extraction — per domain, capped at 50 entities per batch
  const MAX_ENTITIES_PER_RELATION_BATCH = 50;
  const domains = [...new Set(Array.from(docChunksMap.values()).map((d) => d.domain))];

  if (entitiesExtracted > 0 && domains.length > 0) {
    progress("relations", 0, domains.length, "Starting relation extraction...");

    for (let di = 0; di < domains.length; di++) {
      const domain = domains[di];
      progress("relations", di, domains.length, `Extracting relations: ${domain}`);

      try {
        const domainEntities = getEntities({ domain });
        // Cap at MAX_ENTITIES_PER_RELATION_BATCH to stay within token limits
        const entitiesToProcess = domainEntities.slice(0, MAX_ENTITIES_PER_RELATION_BATCH);

        if (entitiesToProcess.length < 2) continue;

        const extractedEntities: ExtractedEntity[] = entitiesToProcess.map((e) => ({
          entity_type: e.entity_type as ExtractedEntity["entity_type"],
          content: e.content,
          status: e.status as ExtractedEntity["status"],
          owner: e.owner,
          confidence: e.confidence,
        }));

        const relations = await extractRelations(extractedEntities);

        if (relations.length > 0) {
          const relationRows = relations.map((r) => ({
            source_entity_id: entitiesToProcess[r.source_index].id,
            target_entity_id: entitiesToProcess[r.target_index].id,
            relation_type: r.relation_type,
            confidence: r.confidence,
          }));
          insertEntityRelations(relationRows);
          relationsExtracted += relations.length;
        }

        console.log(`[index] Domain "${domain}": ${relations.length} relations from ${entitiesToProcess.length} entities`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[index] Relation extraction failed for domain "${domain}":`, msg);
        errors.push({ file: `(relations:${domain})`, error: msg });
      }
    }

    progress("relations", domains.length, domains.length, `Extracted ${relationsExtracted} relations`);
  }

  // Step 6: Change delta computation (only on force re-index with previous data)
  let changeDelta: Record<string, unknown> | undefined;
  if (forceFullReindex && previousEntities.length > 0 && entitiesExtracted > 0) {
    progress("changes", 0, 1, "Computing change delta...");
    try {
      const newEntities = getEntities();
      const chunkDocPaths = getChunkDocumentPathMap();
      const delta = await computeChangeDelta(newEntities, chunkDocPaths, previousEntities);
      changeDelta = delta as unknown as Record<string, unknown>;
      console.log(`[index] Change delta: ${delta.summary.new} new, ${delta.summary.resolved} resolved, ${delta.summary.modified} modified`);
      progress("changes", 1, 1, `Changes: ${delta.summary.new} new, ${delta.summary.resolved} resolved, ${delta.summary.modified} modified`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[index] Change delta computation failed:", msg);
      errors.push({ file: "(change-delta)", error: msg });
    }
  }

  // Create index snapshot
  try {
    const stats = getStats();
    const snapshot = createIndexSnapshot({
      entity_summary: {
        document_count: stats.documentCount,
        chunk_count: stats.chunkCount,
        entity_count: entitiesExtracted,
        relation_count: relationsExtracted,
      },
      change_delta: changeDelta,
    });
    if (changeDelta) {
      updateSnapshotChangeDelta(snapshot.id, changeDelta);
    }
  } catch (err) {
    console.warn("[index] Failed to create index snapshot:", err instanceof Error ? err.message : err);
  }

  const duration = Date.now() - startTime;
  const skippedMsg = skippedCount > 0 ? `, ${skippedCount} skipped (unchanged)` : "";
  progress(
    "done",
    supportedFiles.length,
    supportedFiles.length,
    `Indexed ${documentsProcessed} documents, ${chunksCreated} chunks, ${entitiesExtracted} entities, ${relationsExtracted} relations in ${(duration / 1000).toFixed(1)}s${skippedMsg}`
  );

  return { documentsProcessed, chunksCreated, entitiesExtracted, relationsExtracted, errors, duration };
}

/**
 * Index a single file (for incremental updates via webhook).
 */
export async function indexFile(
  filePath: string,
  github?: GitHubClient
): Promise<{ chunks: number; entities: number }> {
  const client = github ?? getGitHubClient();
  const embedder = getEmbeddingProvider();

  // Fetch content
  const rawUrl = `https://raw.githubusercontent.com/${process.env.GITHUB_REPO}/main/${filePath}`;
  const response = await fetch(rawUrl, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${filePath}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  // Parse and chunk
  const parsed = await parseDocument(buffer, filePath);
  const chunks = chunkDocument(parsed);
  const domain = inferDomain(filePath);

  // Check if document already exists
  const existing = getDocumentByPath(filePath);
  if (existing) {
    deleteEntitiesByDocumentId(existing.id);
    deleteChunksByDocumentId(existing.id);
    await deleteDocumentChunks(filePath);
  }

  // Store in SQLite
  const treeFiles = await client.listFiles();
  const fileInfo = treeFiles.find((f) => f.path === filePath);

  const docRow = upsertDocument({
    path: filePath,
    title: parsed.title,
    format: parsed.format,
    sha: fileInfo?.sha,
    size_bytes: fileInfo?.size,
    domain,
    chunk_count: chunks.length,
  });

  insertChunks(
    chunks.map((c) => ({
      id: c.id,
      document_id: docRow.id,
      chunk_index: c.chunkIndex,
      content: c.content,
      section_path: c.sectionPath,
      section_title: c.sectionTitle,
      token_estimate: c.tokenEstimate,
    }))
  );

  // Embed and store in ChromaDB
  const embeddings = await embedder.generateEmbeddings(
    chunks.map((c) => c.content)
  );

  await addVectorChunks(
    chunks.map((c, j) => ({
      id: c.id,
      content: c.content,
      embedding: embeddings[j].embedding,
      metadata: {
        document_id: String(docRow.id),
        document_path: c.documentPath,
        document_title: c.documentTitle,
        doc_type: c.format,
        domain,
        section_path: c.sectionPath,
        section_title: c.sectionTitle,
        chunk_index: c.chunkIndex,
        token_estimate: c.tokenEstimate,
      },
    }))
  );

  // Entity extraction for webhook-indexed file
  let entityCount = 0;
  try {
    const entityMap = await extractEntitiesBatch(
      chunks.map((c) => ({ content: c.content, tokenEstimate: c.tokenEstimate }))
    );

    for (const [chunkIdx, entities] of entityMap) {
      if (entities.length === 0) continue;
      insertEntities(
        entities.map((e) => ({
          chunk_id: chunks[chunkIdx].id,
          entity_type: e.entity_type,
          content: e.content,
          status: e.status,
          owner: e.owner,
          domain,
          confidence: e.confidence,
        }))
      );
      entityCount += entities.length;
    }
    console.log(`[index] Single file ${filePath}: ${entityCount} entities extracted`);
  } catch (err) {
    console.error(`[index] Entity extraction failed for ${filePath}:`, err instanceof Error ? err.message : err);
  }

  return { chunks: chunks.length, entities: entityCount };
}
