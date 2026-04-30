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
  | "person"
  | "project"
  | "concept"
  | "file"
  | "decision"
  | "feedback"
  | "tool"
  | "preference"
  | "event"
  | "skill"
  | "location"
  | "habit"
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
  content_hash: string | null;
  namespace: string | null;
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
  namespace: string | null;
};

export type EpisodeRow = {
  id: string;
  session_key: string;
  turn_index: number | null;
  content: string;
  extracted_entity_ids: string | null;
  timestamp: number;
  namespace: string | null;
};

export type EpisodeTextUnitRow = {
  id: string;
  episode_id: string;
  turn_index: number | null;
  speaker: string | null;
  content: string;
  start_offset: number | null;
  end_offset: number | null;
  created_at: number;
  namespace: string | null;
};

export type FactAssertionRow = {
  id: string;
  entity_id: string;
  assertion_text: string;
  confidence: number;
  status: "active" | "challenged" | "superseded" | "confirmed";
  source_unit_id: string | null;
  created_at: number;
  updated_at: number;
  namespace: string | null;
};

export type SupersessionProposalRow = {
  id: string;
  target_entity_id: string;
  target_assertion_id: string | null;
  new_assertion_text: string;
  reason: string | null;
  status: "pending" | "approved" | "rejected";
  evidence_unit_id: string | null;
  created_at: number;
  resolved_at: number | null;
  namespace: string | null;
};

export type EntityPropertyRow = {
  id: string;
  entity_id: string;
  key: string;
  value: string;
  value_type: "string" | "number" | "boolean" | "date";
  confidence: number;
  source_unit_id: string | null;
  valid_from: number;
  valid_until: number | null;
  created_at: number;
  updated_at: number;
  namespace: string | null;
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
  /** Embedding dimensions for sqlite-vec ANN index. Default 1536. */
  vecDimensions?: number;
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

  // Content hash for incremental embedding
  try { db.exec(`ALTER TABLE entities ADD COLUMN content_hash TEXT`); } catch { /* already exists */ }

  // Namespace for multi-user isolation (entities)
  try { db.exec(`ALTER TABLE entities ADD COLUMN namespace TEXT`); } catch { /* already exists */ }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_ns ON entities(namespace);`);

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

  // Namespace for multi-user isolation (edges)
  try { db.exec(`ALTER TABLE edges ADD COLUMN namespace TEXT`); } catch { /* already exists */ }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_ns ON edges(namespace);`);

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

  // Namespace for multi-user isolation (episodes)
  try { db.exec(`ALTER TABLE episodes ADD COLUMN namespace TEXT`); } catch { /* already exists */ }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_episodes_ns ON episodes(namespace);`);

  // -- entity_aliases ----------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_aliases (
      alias TEXT NOT NULL,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      namespace TEXT,
      PRIMARY KEY (alias, entity_id)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_aliases_entity ON entity_aliases(entity_id);`);
  try { db.exec(`ALTER TABLE entity_aliases ADD COLUMN namespace TEXT`); } catch { /* already exists */ }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_aliases_ns ON entity_aliases(namespace);`);

  // -- meta (for invalidation audit) ------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // -- episode_text_units (provenance: source text fragments) ------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS episode_text_units (
      id TEXT PRIMARY KEY,
      episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      turn_index INTEGER,
      speaker TEXT,
      content TEXT NOT NULL,
      start_offset INTEGER,
      end_offset INTEGER,
      created_at INTEGER NOT NULL,
      namespace TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_etu_episode ON episode_text_units(episode_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_etu_ns ON episode_text_units(namespace);`);

  // -- fact_assertions (provenance: extracted facts) --------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS fact_assertions (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      assertion_text TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      status TEXT NOT NULL DEFAULT 'active',
      source_unit_id TEXT REFERENCES episode_text_units(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      namespace TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fa_entity ON fact_assertions(entity_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fa_status ON fact_assertions(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fa_ns ON fact_assertions(namespace);`);

  // -- supersession_proposals (provenance: conflict resolution) ---------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS supersession_proposals (
      id TEXT PRIMARY KEY,
      target_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      target_assertion_id TEXT REFERENCES fact_assertions(id),
      new_assertion_text TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      evidence_unit_id TEXT REFERENCES episode_text_units(id),
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      namespace TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sp_target ON supersession_proposals(target_entity_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sp_status ON supersession_proposals(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sp_ns ON supersession_proposals(namespace);`);

  // -- entity_properties (typed key-value properties) -----------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_properties (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      value_type TEXT NOT NULL DEFAULT 'string',
      confidence REAL NOT NULL DEFAULT 1.0,
      source_unit_id TEXT,
      valid_from INTEGER NOT NULL,
      valid_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      namespace TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ep_entity ON entity_properties(entity_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ep_key ON entity_properties(key);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ep_valid ON entity_properties(valid_from, valid_until);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ep_ns ON entity_properties(namespace);`);

  // -- communities -----------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS communities (
      id TEXT PRIMARY KEY,
      label TEXT,
      entity_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      namespace TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_communities_updated ON communities(updated_at);`);
  try { db.exec(`ALTER TABLE communities ADD COLUMN namespace TEXT`); } catch { /* already exists */ }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_communities_ns ON communities(namespace);`);

  // Report summary for community retrieval (2-3 sentence description)
  try { db.exec(`ALTER TABLE communities ADD COLUMN report_summary TEXT`); } catch { /* already exists */ }

  // -- community_members -----------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS community_members (
      community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      PRIMARY KEY (community_id, entity_id)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cm_entity ON community_members(entity_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cm_community ON community_members(community_id);`);

  // -- entity FTS -------------------------------------------------------------
  let entityFtsAvailable = false;
  let entityFtsError: string | undefined;
  const ftsEnabled = params.ftsEnabled ?? true;
  if (ftsEnabled) {
    try {
      // Try to create FTS5 table with namespace support
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${ENTITY_FTS_TABLE} USING fts5(` +
          `name, summary, id UNINDEXED, type UNINDEXED, namespace UNINDEXED);`,
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
    const vecResult = ensureVecIndex(db, params.vecDimensions ?? 1536);
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

  // -- import sessions (progress tracking) ------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_sessions (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      total_chunks INTEGER NOT NULL DEFAULT 0,
      processed_chunks INTEGER NOT NULL DEFAULT 0,
      entities_created INTEGER NOT NULL DEFAULT 0,
      entities_updated INTEGER NOT NULL DEFAULT 0,
      edges_created INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      last_chunk_index INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_import_sessions_status ON import_sessions(status);`);

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
  entity: Pick<EntityRow, "id" | "name" | "summary"> & { namespace?: string | null },
): void {
  db.prepare(`DELETE FROM ${ENTITY_FTS_TABLE} WHERE id = ?`).run(entity.id);
  db.prepare(
    `INSERT INTO ${ENTITY_FTS_TABLE}(name, summary, id, type, namespace) ` +
      `SELECT ?, ?, ?, type, namespace FROM entities WHERE id = ?`,
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
  opts?: { limit?: number; namespace?: string | null },
): Array<{ id: string; rank: number }> {
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];
  const limit = opts?.limit ?? 20;
  const namespace = opts?.namespace;

  if (namespace !== undefined) {
    // Namespace-scoped search
    const nsFilter = namespace === null ? `namespace IS NULL` : `namespace = ?`;
    const params = namespace === null
      ? [sanitized, limit]
      : [sanitized, namespace, limit];
    const rows = db
      .prepare(
        `SELECT id, rank FROM ${ENTITY_FTS_TABLE} WHERE ${ENTITY_FTS_TABLE} MATCH ? AND ${nsFilter} ORDER BY rank LIMIT ?`,
      )
      .all(...params) as Array<{ id: string; rank: number }>;
    return rows;
  }

  // Unscoped search (legacy)
  const rows = db
    .prepare(
      `SELECT id, rank FROM ${ENTITY_FTS_TABLE} WHERE ${ENTITY_FTS_TABLE} MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(sanitized, limit) as Array<{ id: string; rank: number }>;
  return rows;
}
