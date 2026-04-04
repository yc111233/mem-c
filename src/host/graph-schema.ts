import type { DatabaseSync } from "node:sqlite";

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
  embedding: string | null;
  confidence: number;
  source: EntitySource;
  valid_from: number;
  valid_until: number | null;
  created_at: number;
  updated_at: number;
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
}): { entityFtsAvailable: boolean; entityFtsError?: string } {
  const { db } = params;

  // -- entities ---------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      summary TEXT,
      embedding TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      source TEXT NOT NULL DEFAULT 'auto',
      valid_from INTEGER NOT NULL,
      valid_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_valid ON entities(valid_from, valid_until);`);

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

  return { entityFtsAvailable, ...(entityFtsError ? { entityFtsError } : {}) };
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

/** Full-text search over entity names and summaries. */
export function searchEntityFts(
  db: DatabaseSync,
  query: string,
  opts?: { limit?: number },
): Array<{ id: string; rank: number }> {
  const limit = opts?.limit ?? 20;
  const rows = db
    .prepare(
      `SELECT id, rank FROM ${ENTITY_FTS_TABLE} WHERE ${ENTITY_FTS_TABLE} MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(query, limit) as Array<{ id: string; rank: number }>;
  return rows;
}
