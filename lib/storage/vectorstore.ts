import { ChromaClient } from "chromadb";

/**
 * ChromaDB vector store wrapper.
 * Connects to a local ChromaDB server (run: chroma run --path ./data/chroma).
 * Stores chunk embeddings with metadata filters for document_id, doc_type, and domain.
 */

const COLLECTION_NAME = "recall_chunks";

interface ChunkMetadata {
  document_id: string;
  document_path: string;
  document_title: string;
  doc_type: string;
  domain: string;
  section_path: string;
  section_title: string;
  chunk_index: number;
  token_estimate: number;
}

let _client: ChromaClient | null = null;

function getChromaClient(): ChromaClient {
  if (!_client) {
    const host = process.env.CHROMA_HOST ?? "localhost";
    const port = parseInt(process.env.CHROMA_PORT ?? "8000", 10);
    _client = new ChromaClient({ host, port });
  }
  return _client;
}

/**
 * Get or create the chunks collection.
 */
async function getCollection() {
  const client = getChromaClient();
  return client.getOrCreateCollection({
    name: COLLECTION_NAME,
    metadata: { "hnsw:space": "cosine" },
  });
}

/**
 * Add chunks with pre-computed embeddings to the vector store.
 */
export async function addChunks(
  chunks: Array<{
    id: string;
    content: string;
    embedding: number[];
    metadata: ChunkMetadata;
  }>
): Promise<void> {
  if (chunks.length === 0) return;

  const collection = await getCollection();

  // ChromaDB has a max batch size; split into batches of 100
  const batchSize = 100;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    await collection.add({
      ids: batch.map((c) => c.id),
      documents: batch.map((c) => c.content),
      embeddings: batch.map((c) => c.embedding),
      metadatas: batch.map((c) => c.metadata as unknown as Record<string, string | number | boolean>),
    });
  }
}

/**
 * Query for similar chunks using a pre-computed query embedding.
 */
export async function querySimilarChunks(
  queryEmbedding: number[],
  options?: {
    nResults?: number;
    where?: Record<string, string>;
  }
): Promise<
  Array<{
    id: string;
    content: string;
    metadata: ChunkMetadata;
    distance: number;
  }>
> {
  const collection = await getCollection();

  const results = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: options?.nResults ?? 10,
    where: options?.where as Record<string, string> | undefined,
    include: ["documents", "metadatas", "distances"],
  });

  const items: Array<{
    id: string;
    content: string;
    metadata: ChunkMetadata;
    distance: number;
  }> = [];

  const ids = results.ids[0] ?? [];
  const docs = results.documents?.[0] ?? [];
  const metas = results.metadatas?.[0] ?? [];
  const dists = results.distances?.[0] ?? [];

  for (let i = 0; i < ids.length; i++) {
    items.push({
      id: ids[i],
      content: (docs[i] as string) ?? "",
      metadata: (metas[i] as unknown as ChunkMetadata) ?? {},
      distance: (dists[i] as number) ?? 0,
    });
  }

  return items;
}

/**
 * Delete all chunks for a specific document.
 */
export async function deleteDocumentChunks(
  documentPath: string
): Promise<void> {
  const collection = await getCollection();
  await collection.delete({
    where: { document_path: documentPath },
  });
}

/**
 * Delete the entire collection (for full re-index).
 */
export async function resetCollection(): Promise<void> {
  const client = getChromaClient();
  try {
    await client.deleteCollection({ name: COLLECTION_NAME });
  } catch {
    // Collection may not exist yet
  }
}

/**
 * Get collection stats.
 */
export async function getCollectionStats(): Promise<{
  count: number;
  name: string;
}> {
  try {
    const collection = await getCollection();
    const count = await collection.count();
    return { count, name: COLLECTION_NAME };
  } catch {
    return { count: 0, name: COLLECTION_NAME };
  }
}

/**
 * Health check for ChromaDB connection.
 */
export async function chromaHealthCheck(): Promise<{
  available: boolean;
  error?: string;
}> {
  try {
    const client = getChromaClient();
    await client.heartbeat();
    return { available: true };
  } catch (error) {
    return {
      available: false,
      error:
        error instanceof Error
          ? `Cannot connect to ChromaDB: ${error.message}`
          : String(error),
    };
  }
}
