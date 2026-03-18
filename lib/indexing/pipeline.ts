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
} from "../storage";

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

  if (forceFullReindex) {
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
      deleteChunksByDocumentId(doc.id);
      await deleteDocumentChunks(doc.path);
      deleteDocument(doc.path);
    }

    // Clean old data for files being reprocessed
    for (const file of filesToProcess) {
      const existing = existingByPath.get(file.path);
      if (existing) {
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

      chunksCreated += chunks.length;
      documentsProcessed++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[index] Error processing ${file.path}:`, msg);
      errors.push({ file: file.path, error: msg });
    }
  }

  // Create index snapshot
  try {
    const stats = getStats();
    createIndexSnapshot({
      entity_summary: { document_count: stats.documentCount, chunk_count: stats.chunkCount },
    });
  } catch (err) {
    console.warn("[index] Failed to create index snapshot:", err instanceof Error ? err.message : err);
  }

  const duration = Date.now() - startTime;
  const skippedMsg = skippedCount > 0 ? `, ${skippedCount} skipped (unchanged)` : "";
  progress(
    "done",
    supportedFiles.length,
    supportedFiles.length,
    `Indexed ${documentsProcessed} documents, ${chunksCreated} chunks in ${(duration / 1000).toFixed(1)}s${skippedMsg}`
  );

  return { documentsProcessed, chunksCreated, errors, duration };
}

/**
 * Index a single file (for incremental updates via webhook).
 */
export async function indexFile(
  filePath: string,
  github?: GitHubClient
): Promise<{ chunks: number }> {
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

  return { chunks: chunks.length };
}
