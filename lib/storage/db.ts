import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

/**
 * SQLite database for structured data.
 * Stores documents, chunks, entities, and relations.
 */

const DEFAULT_DATA_DIR = process.env.NODE_ENV === "production" ? "/data" : "./data";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    const dataDir = process.env.DATA_DIR ?? DEFAULT_DATA_DIR;
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, "repointel.db");
    _db = new Database(dbPath);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    initSchema(_db);
  }
  return _db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      format TEXT NOT NULL,
      sha TEXT,
      size_bytes INTEGER,
      domain TEXT DEFAULT '',
      chunk_count INTEGER DEFAULT 0,
      indexed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      section_path TEXT NOT NULL,
      section_title TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(document_id, chunk_index)
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
    CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path);
    CREATE INDEX IF NOT EXISTS idx_documents_domain ON documents(domain);

    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      owner TEXT,
      domain TEXT DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0.5,
      first_seen_at TEXT DEFAULT (datetime('now')),
      last_seen_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS entity_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      target_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5
    );

    CREATE TABLE IF NOT EXISTS index_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      github_sha TEXT,
      entity_summary TEXT,
      health_scores TEXT,
      change_delta TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_entities_chunk_id ON entities(chunk_id);
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
    CREATE INDEX IF NOT EXISTS idx_entities_domain ON entities(domain);
    CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status);
    CREATE INDEX IF NOT EXISTS idx_entities_owner ON entities(owner);
    CREATE INDEX IF NOT EXISTS idx_entity_relations_source ON entity_relations(source_entity_id);
    CREATE INDEX IF NOT EXISTS idx_entity_relations_target ON entity_relations(target_entity_id);
  `);
}

// --- Document CRUD ---

export interface DocumentRow {
  id: number;
  path: string;
  title: string;
  format: string;
  sha: string | null;
  size_bytes: number | null;
  domain: string;
  chunk_count: number;
  indexed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChunkRow {
  id: string;
  document_id: number;
  chunk_index: number;
  content: string;
  section_path: string;
  section_title: string;
  token_estimate: number;
  created_at: string;
}

export function upsertDocument(doc: {
  path: string;
  title: string;
  format: string;
  sha?: string;
  size_bytes?: number;
  domain?: string;
  chunk_count?: number;
}): DocumentRow {
  const db = getDb();

  const existing = db
    .prepare("SELECT * FROM documents WHERE path = ?")
    .get(doc.path) as DocumentRow | undefined;

  if (existing) {
    db.prepare(
      `UPDATE documents
       SET title = ?, format = ?, sha = ?, size_bytes = ?, domain = ?,
           chunk_count = ?, indexed_at = datetime('now'), updated_at = datetime('now')
       WHERE path = ?`
    ).run(
      doc.title,
      doc.format,
      doc.sha ?? null,
      doc.size_bytes ?? null,
      doc.domain ?? "",
      doc.chunk_count ?? 0,
      doc.path
    );
    return db
      .prepare("SELECT * FROM documents WHERE path = ?")
      .get(doc.path) as DocumentRow;
  }

  const result = db.prepare(
    `INSERT INTO documents (path, title, format, sha, size_bytes, domain, chunk_count, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    doc.path,
    doc.title,
    doc.format,
    doc.sha ?? null,
    doc.size_bytes ?? null,
    doc.domain ?? "",
    doc.chunk_count ?? 0
  );

  return db
    .prepare("SELECT * FROM documents WHERE id = ?")
    .get(result.lastInsertRowid) as DocumentRow;
}

export function getDocumentByPath(
  docPath: string
): DocumentRow | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM documents WHERE path = ?")
    .get(docPath) as DocumentRow | undefined;
}

export function getAllDocuments(): DocumentRow[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM documents ORDER BY path")
    .all() as DocumentRow[];
}

export function deleteDocument(docPath: string): void {
  const db = getDb();
  db.prepare("DELETE FROM documents WHERE path = ?").run(docPath);
}

// --- Chunk CRUD ---

export function insertChunks(
  chunks: Array<{
    id: string;
    document_id: number;
    chunk_index: number;
    content: string;
    section_path: string;
    section_title: string;
    token_estimate: number;
  }>
): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT OR REPLACE INTO chunks (id, document_id, chunk_index, content, section_path, section_title, token_estimate)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const insertMany = db.transaction(
    (
      items: Array<{
        id: string;
        document_id: number;
        chunk_index: number;
        content: string;
        section_path: string;
        section_title: string;
        token_estimate: number;
      }>
    ) => {
      for (const chunk of items) {
        insert.run(
          chunk.id,
          chunk.document_id,
          chunk.chunk_index,
          chunk.content,
          chunk.section_path,
          chunk.section_title,
          chunk.token_estimate
        );
      }
    }
  );

  insertMany(chunks);
}

export function getChunksByDocumentId(documentId: number): ChunkRow[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM chunks WHERE document_id = ? ORDER BY chunk_index"
    )
    .all(documentId) as ChunkRow[];
}

export function deleteChunksByDocumentId(documentId: number): void {
  const db = getDb();
  db.prepare("DELETE FROM chunks WHERE document_id = ?").run(documentId);
}

/**
 * Get total stats.
 */
export function getStats(): {
  documentCount: number;
  chunkCount: number;
  totalTokens: number;
} {
  const db = getDb();
  const docs = db
    .prepare("SELECT COUNT(*) as count FROM documents")
    .get() as { count: number };
  const chunks = db
    .prepare(
      "SELECT COUNT(*) as count, COALESCE(SUM(token_estimate), 0) as tokens FROM chunks"
    )
    .get() as { count: number; tokens: number };

  return {
    documentCount: docs.count,
    chunkCount: chunks.count,
    totalTokens: chunks.tokens,
  };
}

/**
 * Clear all data (for full re-index).
 */
export function clearAll(): void {
  const db = getDb();
  db.exec("DELETE FROM entity_relations; DELETE FROM entities; DELETE FROM chunks; DELETE FROM documents; DELETE FROM index_snapshots;");
}

/**
 * Health check for SQLite connection.
 */
export function dbHealthCheck(): {
  available: boolean;
  path: string;
  error?: string;
} {
  try {
    const db = getDb();
    db.prepare("SELECT 1").get();
    const dataDir = process.env.DATA_DIR ?? DEFAULT_DATA_DIR;
    return {
      available: true,
      path: path.join(dataDir, "repointel.db"),
    };
  } catch (error) {
    const dataDir = process.env.DATA_DIR ?? DEFAULT_DATA_DIR;
    return {
      available: false,
      path: path.join(dataDir, "repointel.db"),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// --- Entity CRUD ---

export interface EntityRow {
  id: number;
  chunk_id: string;
  entity_type: string;
  content: string;
  status: string;
  owner: string | null;
  domain: string;
  confidence: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}

export interface EntityRelationRow {
  id: number;
  source_entity_id: number;
  target_entity_id: number;
  relation_type: string;
  confidence: number;
}

export interface IndexSnapshotRow {
  id: number;
  created_at: string;
  github_sha: string | null;
  entity_summary: string | null;
  health_scores: string | null;
  change_delta: string | null;
}

export function insertEntities(
  entities: Array<{
    chunk_id: string;
    entity_type: string;
    content: string;
    status: string;
    owner: string | null;
    domain: string;
    confidence: number;
  }>
): EntityRow[] {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO entities (chunk_id, entity_type, content, status, owner, domain, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const inserted: EntityRow[] = [];

  const insertMany = db.transaction(
    (
      items: Array<{
        chunk_id: string;
        entity_type: string;
        content: string;
        status: string;
        owner: string | null;
        domain: string;
        confidence: number;
      }>
    ) => {
      for (const entity of items) {
        const result = insert.run(
          entity.chunk_id,
          entity.entity_type,
          entity.content,
          entity.status,
          entity.owner,
          entity.domain,
          entity.confidence
        );
        inserted.push(
          db
            .prepare("SELECT * FROM entities WHERE id = ?")
            .get(result.lastInsertRowid) as EntityRow
        );
      }
    }
  );

  insertMany(entities);
  return inserted;
}

export function insertEntityRelations(
  relations: Array<{
    source_entity_id: number;
    target_entity_id: number;
    relation_type: string;
    confidence: number;
  }>
): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO entity_relations (source_entity_id, target_entity_id, relation_type, confidence)
     VALUES (?, ?, ?, ?)`
  );

  const insertMany = db.transaction(
    (
      items: Array<{
        source_entity_id: number;
        target_entity_id: number;
        relation_type: string;
        confidence: number;
      }>
    ) => {
      for (const rel of items) {
        insert.run(
          rel.source_entity_id,
          rel.target_entity_id,
          rel.relation_type,
          rel.confidence
        );
      }
    }
  );

  insertMany(relations);
}

export function getEntities(filters?: {
  type?: string;
  domain?: string;
  status?: string;
  owner?: string;
}): EntityRow[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.type) {
    conditions.push("entity_type = ?");
    params.push(filters.type);
  }
  if (filters?.domain) {
    conditions.push("domain = ?");
    params.push(filters.domain);
  }
  if (filters?.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters?.owner) {
    conditions.push("owner = ?");
    params.push(filters.owner);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM entities ${where} ORDER BY first_seen_at DESC`)
    .all(...params) as EntityRow[];
}

export function getEntityById(id: number): EntityRow | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM entities WHERE id = ?")
    .get(id) as EntityRow | undefined;
}

export function getEntityRelations(entityId: number): EntityRelationRow[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM entity_relations WHERE source_entity_id = ? OR target_entity_id = ?"
    )
    .all(entityId, entityId) as EntityRelationRow[];
}

export function getChunkById(chunkId: string): ChunkRow | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM chunks WHERE id = ?")
    .get(chunkId) as ChunkRow | undefined;
}

export function deleteEntitiesByIds(entityIds: number[]): number {
  if (entityIds.length === 0) return 0;
  const db = getDb();
  const placeholders = entityIds.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM entity_relations WHERE source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders})`
  ).run(...entityIds, ...entityIds);
  const result = db.prepare(
    `DELETE FROM entities WHERE id IN (${placeholders})`
  ).run(...entityIds);
  return result.changes;
}

export function deleteEntitiesByChunkId(chunkId: string): void {
  const db = getDb();
  const entityIds = db
    .prepare("SELECT id FROM entities WHERE chunk_id = ?")
    .all(chunkId) as Array<{ id: number }>;

  if (entityIds.length > 0) {
    const ids = entityIds.map((e) => e.id);
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM entity_relations WHERE source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders})`
    ).run(...ids, ...ids);
    db.prepare(`DELETE FROM entities WHERE chunk_id = ?`).run(chunkId);
  }
}

export function deleteEntitiesByDocumentId(documentId: number): void {
  const db = getDb();
  const chunks = db
    .prepare("SELECT id FROM chunks WHERE document_id = ?")
    .all(documentId) as Array<{ id: string }>;

  for (const chunk of chunks) {
    deleteEntitiesByChunkId(chunk.id);
  }
}

export function createIndexSnapshot(snapshot: {
  github_sha?: string;
  entity_summary: Record<string, unknown>;
  health_scores?: Record<string, unknown>;
  change_delta?: Record<string, unknown>;
}): IndexSnapshotRow {
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO index_snapshots (github_sha, entity_summary, health_scores, change_delta)
     VALUES (?, ?, ?, ?)`
  ).run(
    snapshot.github_sha ?? null,
    JSON.stringify(snapshot.entity_summary),
    snapshot.health_scores ? JSON.stringify(snapshot.health_scores) : null,
    snapshot.change_delta ? JSON.stringify(snapshot.change_delta) : null
  );

  return db
    .prepare("SELECT * FROM index_snapshots WHERE id = ?")
    .get(result.lastInsertRowid) as IndexSnapshotRow;
}

export function getEntitiesWithDocumentPath(): Array<EntityRow & { document_path: string }> {
  const db = getDb();
  return db
    .prepare(
      `SELECT e.*, d.path as document_path
       FROM entities e
       JOIN chunks c ON e.chunk_id = c.id
       JOIN documents d ON c.document_id = d.id
       ORDER BY e.id`
    )
    .all() as Array<EntityRow & { document_path: string }>;
}

export function getLatestSnapshot(): IndexSnapshotRow | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM index_snapshots ORDER BY created_at DESC LIMIT 1")
    .get() as IndexSnapshotRow | undefined;
}

export function getRecentSnapshots(limit: number = 10): IndexSnapshotRow[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM index_snapshots ORDER BY created_at DESC LIMIT ?")
    .all(limit) as IndexSnapshotRow[];
}

export function updateSnapshotChangeDelta(
  snapshotId: number,
  changeDelta: Record<string, unknown>
): void {
  const db = getDb();
  db.prepare("UPDATE index_snapshots SET change_delta = ? WHERE id = ?").run(
    JSON.stringify(changeDelta),
    snapshotId
  );
}

export function updateEntityLastSeen(entityIds: number[]): void {
  if (entityIds.length === 0) return;
  const db = getDb();
  const placeholders = entityIds.map(() => "?").join(",");
  db.prepare(
    `UPDATE entities SET last_seen_at = datetime('now') WHERE id IN (${placeholders})`
  ).run(...entityIds);
}

export function updateEntityResolved(entityIds: number[]): void {
  if (entityIds.length === 0) return;
  const db = getDb();
  const placeholders = entityIds.map(() => "?").join(",");
  db.prepare(
    `UPDATE entities SET resolved_at = datetime('now'), status = 'resolved' WHERE id IN (${placeholders})`
  ).run(...entityIds);
}

export function getChunkDocumentPathMap(): Map<string, string> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT c.id as chunk_id, d.path as document_path
       FROM chunks c
       JOIN documents d ON c.document_id = d.id`
    )
    .all() as Array<{ chunk_id: string; document_path: string }>;

  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.chunk_id, row.document_path);
  }
  return map;
}

export function getEntityStats(): {
  total: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
} {
  const db = getDb();
  const total = (
    db.prepare("SELECT COUNT(*) as count FROM entities").get() as { count: number }
  ).count;

  const byType: Record<string, number> = {};
  const typeRows = db
    .prepare("SELECT entity_type, COUNT(*) as count FROM entities GROUP BY entity_type")
    .all() as Array<{ entity_type: string; count: number }>;
  for (const row of typeRows) {
    byType[row.entity_type] = row.count;
  }

  const byStatus: Record<string, number> = {};
  const statusRows = db
    .prepare("SELECT status, COUNT(*) as count FROM entities GROUP BY status")
    .all() as Array<{ status: string; count: number }>;
  for (const row of statusRows) {
    byStatus[row.status] = row.count;
  }

  return { total, byType, byStatus };
}
