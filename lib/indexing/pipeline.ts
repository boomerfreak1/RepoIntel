import fs from "fs";
import { GitHubClient, getGitHubClient } from "../github";
import { parseDocument, isSupported } from "../parsers";
import { chunkDocument } from "./chunker";
import { getEmbeddingProvider } from "../embeddings";
import { extractEntitiesBatch, extractRelations, type ExtractedEntity } from "../ai/extractor";
import { computeChangeDelta, PreviousEntity } from "./differ";
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
  getEntitiesWithDocumentPath,
  getChunkDocumentPathMap,
  updateSnapshotChangeDelta,
  deleteEntitiesByDocumentId,
} from "../storage";
import type { EntityRow } from "../storage";

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

  // Snapshot previous entities for change delta computation (before clearing)
  let previousEntities: PreviousEntity[] = [];
  if (forceFullReindex) {
    try {
      previousEntities = getEntitiesWithDocumentPath().map((e) => ({
        id: e.id,
        entity_type: e.entity_type,
        content: e.content,
        status: e.status,
        owner: e.owner ?? null,
        domain: e.domain,
        document_path: e.document_path,
      }));
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
  const allNewChunks: Array<{ id: string; content: string; token_estimate: number; domain: string }> = [];

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

      // Collect chunks for extraction
      for (const c of chunks) {
        allNewChunks.push({ id: c.id, content: c.content, token_estimate: c.tokenEstimate, domain });
      }

      chunksCreated += chunks.length;
      documentsProcessed++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[index] Error processing ${file.path}:`, msg);
      errors.push({ file: file.path, error: msg });
    }
  }

  // Step 4: Entity extraction
  if (allNewChunks.length > 0) {
    try {
      progress("extract", 0, allNewChunks.length, "Extracting entities from chunks...");
      const chunkInputs = allNewChunks.map((c) => ({ content: c.content, tokenEstimate: c.token_estimate }));
      const extractionMap = await extractEntitiesBatch(chunkInputs, (completed) => {
        progress("extract", completed, allNewChunks.length, `Extracted entities from ${completed}/${allNewChunks.length} chunks`);
      });

      // Build chunk-to-document-path map for domain attribution
      const chunkDocPathMap = getChunkDocumentPathMap();

      for (const [chunkIdx, entities] of extractionMap.entries()) {
        if (entities.length === 0) continue;
        const chunk = allNewChunks[chunkIdx];
        const docPath = chunkDocPathMap.get(chunk.id);
        const domain = chunk.domain;

        const rows = insertEntities(
          entities.map((e) => ({
            chunk_id: chunk.id,
            entity_type: e.entity_type,
            content: e.content,
            status: e.status,
            owner: e.owner ?? null,
            confidence: e.confidence,
            domain,
          }))
        );
        entitiesExtracted += rows.length;
      }
      console.log(`[index] Extracted ${entitiesExtracted} entities from ${allNewChunks.length} chunks`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[index] Entity extraction failed (non-fatal):", msg);
      errors.push({ file: "entity-extraction", error: msg });
    }
  }

  // Step 5: Relation extraction (grouped by domain, capped at 50 entities per batch)
  if (entitiesExtracted > 0) {
    try {
      progress("relations", 0, 1, "Extracting relations between entities...");
      const allEntities = getEntitiesWithDocumentPath();
      const byDomain = new Map<string, EntityRow[]>();
      for (const e of allEntities) {
        const domain = e.domain ?? "general";
        if (!byDomain.has(domain)) byDomain.set(domain, []);
        byDomain.get(domain)!.push(e);
      }

      let domainIdx = 0;
      for (const [domain, domainEntities] of byDomain) {
        progress("relations", domainIdx, byDomain.size, `Extracting relations for domain: ${domain}`);
        // Cap at 50 entities per batch to stay within token limits
        const batch = domainEntities.slice(0, 50);
        try {
          const relations = await extractRelations(
            batch.map((e) => ({
              entity_type: e.entity_type as ExtractedEntity["entity_type"],
              content: e.content,
              status: e.status as ExtractedEntity["status"],
              owner: e.owner ?? null,
              confidence: e.confidence,
            }))
          );

          if (relations.length > 0) {
            insertEntityRelations(
              relations.map((r) => ({
                source_entity_id: batch[r.source_index]?.id,
                target_entity_id: batch[r.target_index]?.id,
                relation_type: r.relation_type,
                confidence: r.confidence,
              })).filter((r) => r.source_entity_id && r.target_entity_id)
            );
            relationsExtracted += relations.length;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[index] Relation extraction failed for domain ${domain} (non-fatal):`, msg);
          errors.push({ file: `relations-${domain}`, error: msg });
        }
        domainIdx++;
      }
      console.log(`[index] Extracted ${relationsExtracted} relations across ${byDomain.size} domains`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[index] Relation extraction failed (non-fatal):", msg);
      errors.push({ file: "relation-extraction", error: msg });
    }
  }

  // Step 6: Create index snapshot and compute change delta
  try {
    const stats = getStats();
    const snapshot = createIndexSnapshot({
      entity_summary: {
        document_count: stats.documentCount,
        chunk_count: stats.chunkCount,
        entity_count: entitiesExtracted,
        relation_count: relationsExtracted,
      },
    });

    if (previousEntities.length > 0) {
      try {
        progress("changes", 0, 1, "Computing change delta...");
        const currentEntities = getEntitiesWithDocumentPath();
        const docPathMap = getChunkDocumentPathMap();
        const changeDelta = await computeChangeDelta(
          currentEntities,
          docPathMap,
          previousEntities
        );
        updateSnapshotChangeDelta(snapshot.id, changeDelta as unknown as Record<string, unknown>);
        progress("changes", 1, 1, `Change delta: ${changeDelta.summary?.new ?? 0} new, ${changeDelta.summary?.resolved ?? 0} resolved, ${changeDelta.summary?.modified ?? 0} modified`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[index] Change delta computation failed (non-fatal):", msg);
        errors.push({ file: "change-delta", error: msg });
      }
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

  // Extract entities from new chunks (non-fatal)
  let entityCount = 0;
  try {
    const chunkInputs = chunks.map((c) => ({ content: c.content, tokenEstimate: c.tokenEstimate }));
    const extractionMap = await extractEntitiesBatch(chunkInputs);
    for (const [chunkIdx, entities] of extractionMap.entries()) {
      if (entities.length === 0) continue;
      const chunk = chunks[chunkIdx];
      const rows = insertEntities(
        entities.map((e) => ({
          chunk_id: chunk.id,
          entity_type: e.entity_type,
          content: e.content,
          status: e.status,
          owner: e.owner ?? null,
          confidence: e.confidence,
          domain,
        }))
      );
      entityCount += rows.length;
    }
  } catch (err) {
    console.warn(`[index] Entity extraction failed for ${filePath} (non-fatal):`, err instanceof Error ? err.message : err);
  }

  return { chunks: chunks.length, entities: entityCount };
}
