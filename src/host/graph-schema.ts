import type { DatabaseSync } from "node:sqlite";
import type { MemoryGraphEngine } from "./graph-engine.js";
import { ensureVecIndex, vecSyncAll } from "./graph-vec.js";

/**
 * Entity types supported by the memory graph.
 * Extensions may store custom types as free-form strings; these are the
 * well-known types that get special treatment in retrieval and display.
 */
export type EntityType =
  | "user"
  | "project"
  | "concept"
  | "file"
  | "decision"
  | "feedback"
  | "tool"
  | "preference"
  | (string & {});

export type EntitySource = "auto" | "manual" | "imported";

// ---------------------------------------------------------------------------
// Row types (mirror the SQLite schema)
// ---------------------------------------------------------------------------

export type EntityRow = {
  id: string;
  name: string;
  type: EntityType;
  summary: string | null;
  embedding: string | Buffer | null;
  confidence: number;
  source: EntitySource;
  valid_from: number;
  valid_until: number | null;
  created_at: number;
  updated_at: number;
  access_count: number;
  last_accessed_at: number;
};

export type EdgeRow = {
  id: string;
  from_id: string;
  to_id: string;
  relation: string;
  weight: number;
  metadata: string | null;
  valid_from: number;
  valid_until: number | null;
  created_at: number;
};

export type EpisodeRow = {
  id: string;
  session_key: string;
  turn_index: number | null;
  content: string;
  extracted_entity_ids: string | null;
  timestamp: number;
};

// ---------------------------------------------------------------------------
// FTS virtual table for entity search
// ---------------------------------------------------------------------------

const ENTITY_FTS_TABLE = "entities_fts";

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

export function ensureGraphSchema(params: {
  db: DatabaseSync;
  ftsEnabled?: boolean;
  engine?: MemoryGraphEngine;
}): { entityFtsAvailable: boolean; entityFtsError?: string; vecAvailable: boolean; vecError?: string } {
  const { db } = params;

  // -- WAL mode + busy timeout (safe for multi-process concurrent access) ------
  db.exec(`PRAGMA journal_mode = WAL`);
  db.exec(`PRAGMA busy_timeout = 5000`);

  // -- entities ---------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      summary TEXT,
      embedding BLOB,
      confidence REAL NOT NULL DEFAULT 1.0,
      source TEXT NOT NULL DEFAULT 'auto',
      valid_from INTEGER NOT NULL,
      valid_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_valid ON entities(valid_from, valid_until);`);

  // Migration for pre-v2 databases: add access tracking columns.
  // On fresh databases these columns already exist in CREATE TABLE; ALTER silently fails.
  try { db.exec(`ALTER TABLE entities ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE entities ADD COLUMN last_accessed_at INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }

  // -- edges ------------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      to_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      relation TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      metadata TEXT,
      valid_from INTEGER NOT NULL,
      valid_until INTEGER,
      created_at INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_dedup ON edges(from_id, to_id, relation);`);

  // -- episodes ---------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      turn_index INTEGER,
      content TEXT NOT NULL,
      extracted_entity_ids TEXT,
      timestamp INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_key);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_episodes_ts ON episodes(timestamp);`);

  // -- entity_aliases ----------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_aliases (
      alias TEXT NOT NULL,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (alias, entity_id)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_aliases_entity ON entity_aliases(entity_id);`);

  // -- meta (for invalidation audit) ------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // -- entity FTS -------------------------------------------------------------
  let entityFtsAvailable = false;
  let entityFtsError: string | undefined;
  const ftsEnabled = params.ftsEnabled ?? true;
  if (ftsEnabled) {
    try {
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${ENTITY_FTS_TABLE} USING fts5(` +
          `name, summary, id UNINDEXED, type UNINDEXED);`,
      );
      entityFtsAvailable = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entityFtsError = message;
    }
  }

  // -- sqlite-vec ANN index ----------------------------------------------------
  let vecAvailable = false;
  let vecError: string | undefined;
  try {
    const vecResult = ensureVecIndex(db, 1536);
    vecAvailable = vecResult.available;
    vecError = vecResult.error;
  } catch {
    // vec not available — non-fatal
  }

  // Sync existing embeddings into vec index on first init
  if (vecAvailable) {
    vecSyncAll(db, true);
  }

  // Wire vec availability to engine if provided
  if (params.engine) {
    params.engine.setVecAvailable(vecAvailable);
  }

  // -- Embedding TEXT → BLOB migration -----------------------------------------
  try {
    const textRow = db
      .prepare(
        `SELECT id FROM entities WHERE embedding IS NOT NULL AND typeof(embedding) = 'text' LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (textRow) {
      const rows = db
        .prepare(`SELECT id, embedding FROM entities WHERE embedding IS NOT NULL AND typeof(embedding) = 'text'`)
        .all() as Array<{ id: string; embedding: string }>;
      const update = db.prepare(`UPDATE entities SET embedding = ? WHERE id = ?`);
      for (const row of rows) {
        try {
          const vec = JSON.parse(row.embedding) as number[];
          const blob = Buffer.from(new Float32Array(vec).buffer);
          update.run(blob, row.id);
        } catch {
          // Skip corrupted embeddings
        }
      }
    }
  } catch {
    // Migration is best-effort
  }

  return { entityFtsAvailable, ...(entityFtsError ? { entityFtsError } : {}), vecAvailable, ...(vecError ? { vecError } : {}) };
}

/** Sync an entity row into the FTS index (upsert). */
export function syncEntityFts(
  db: DatabaseSync,
  entity: Pick<EntityRow, "id" | "name" | "summary">,
): void {
  db.prepare(`DELETE FROM ${ENTITY_FTS_TABLE} WHERE id = ?`).run(entity.id);
  db.prepare(
    `INSERT INTO ${ENTITY_FTS_TABLE}(name, summary, id, type) ` +
      `SELECT ?, ?, ?, type FROM entities WHERE id = ?`,
  ).run(entity.name, entity.summary ?? "", entity.id, entity.id);
}

/** Remove an entity from the FTS index. */
export function removeEntityFts(db: DatabaseSync, entityId: string): void {
  db.prepare(`DELETE FROM ${ENTITY_FTS_TABLE} WHERE id = ?`).run(entityId);
}

/**
 * Sanitize a user query for FTS5 MATCH.
 * Strips FTS5 operators and wraps remaining terms in double quotes.
 */
export function sanitizeFtsQuery(query: string): string {
  // Remove FTS5 special operators
  const stripped = query.replace(/["\*\(\)\{\}\^~:]/g, " ");
  // Split into words, filter empties, wrap each in quotes
  const terms = stripped.split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t}"`).join(" ");
}

/** Full-text search over entity names and summaries. */
export function searchEntityFts(
  db: DatabaseSync,
  query: string,
  opts?: { limit?: number },
): Array<{ id: string; rank: number }> {
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];
  const limit = opts?.limit ?? 20;
  const rows = db
    .prepare(
      `SELECT id, rank FROM ${ENTITY_FTS_TABLE} WHERE ${ENTITY_FTS_TABLE} MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(sanitized, limit) as Array<{ id: string; rank: number }>;
  return rows;
}
