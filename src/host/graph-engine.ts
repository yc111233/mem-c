import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  removeEntityFts,
  syncEntityFts,
  type EdgeRow,
  type EntityRow,
  type EntitySource,
  type EntityType,
  type EpisodeRow,
} from "./graph-schema.js";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export type EntityInput = {
  name: string;
  type: EntityType;
  summary?: string;
  embedding?: number[];
  confidence?: number;
  source?: EntitySource;
  validFrom?: number;
};

export type EdgeInput = {
  fromId: string;
  toId: string;
  relation: string;
  weight?: number;
  metadata?: Record<string, unknown>;
  validFrom?: number;
};

export type EpisodeInput = {
  sessionKey: string;
  turnIndex?: number;
  content: string;
  extractedEntityIds?: string[];
};

// ---------------------------------------------------------------------------
// Query types
// ---------------------------------------------------------------------------

export type EntityQuery = {
  name?: string;
  type?: EntityType;
  /** Only return currently-valid entities (valid_until IS NULL). Default true. */
  activeOnly?: boolean;
  limit?: number;
};

export type EdgeQuery = {
  entityId?: string;
  relation?: string;
  direction?: "outgoing" | "incoming" | "both";
  activeOnly?: boolean;
  limit?: number;
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type Entity = EntityRow & {
  embeddingVector?: number[];
};

export type Edge = EdgeRow & {
  metadataParsed?: Record<string, unknown>;
};

export type GraphSubset = {
  entities: Entity[];
  edges: Edge[];
};

export type EntityVersion = {
  entity: Entity;
  supersededBy?: string;
};

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class MemoryGraphEngine {
  constructor(private readonly db: DatabaseSync) {}

  /** Expose the underlying database for advanced queries (e.g. episode lookups). */
  getDb(): DatabaseSync {
    return this.db;
  }

  // NOTE: This flag assumes single-threaded access (node:sqlite's DatabaseSync is synchronous).
  // If the engine is ever shared across concurrent async contexts, this needs a proper mutex.
  private inTransaction = false;

  /** Run a function inside a SQLite transaction. Supports nesting (inner calls are no-ops). */
  runInTransaction<T>(fn: () => T): T {
    if (this.inTransaction) {
      return fn();
    }
    this.inTransaction = true;
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  // -- Entity CRUD ----------------------------------------------------------

  upsertEntity(input: EntityInput): Entity & { isNew: boolean } {
    return this.runInTransaction(() => {
      const now = Date.now();
      const embeddingJson = input.embedding ? JSON.stringify(input.embedding) : null;

      // Try to find existing active entity with same name+type
      const existing = this.db
        .prepare(
          `SELECT * FROM entities WHERE name = ? AND type = ? AND valid_until IS NULL LIMIT 1`,
        )
        .get(input.name, input.type) as EntityRow | undefined;

      if (existing) {
        // Update existing entity
        this.db
          .prepare(
            `UPDATE entities SET summary = COALESCE(?, summary), embedding = COALESCE(?, embedding), ` +
              `confidence = ?, source = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            input.summary ?? null,
            embeddingJson,
            input.confidence ?? existing.confidence,
            input.source ?? existing.source,
            now,
            existing.id,
          );

        const updated = this.db
          .prepare(`SELECT * FROM entities WHERE id = ?`)
          .get(existing.id) as EntityRow;

        syncEntityFts(this.db, updated);
        return { ...toEntity(updated), isNew: false };
      }

      // Insert new entity
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO entities (id, name, type, summary, embedding, confidence, source, valid_from, valid_until, created_at, updated_at) ` +
            `VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.type,
          input.summary ?? null,
          embeddingJson,
          input.confidence ?? 1.0,
          input.source ?? "auto",
          input.validFrom ?? now,
          now,
          now,
        );

      const row = this.db.prepare(`SELECT * FROM entities WHERE id = ?`).get(id) as EntityRow;
      syncEntityFts(this.db, row);
      return { ...toEntity(row), isNew: true };
    });
  }

  getEntity(id: string): Entity | null {
    const row = this.db.prepare(`SELECT * FROM entities WHERE id = ?`).get(id) as
      | EntityRow
      | undefined;
    return row ? toEntity(row) : null;
  }

  findEntities(query: EntityQuery): Entity[] {
    const conditions: string[] = [];
    const params: (string | number | null)[] = [];
    const activeOnly = query.activeOnly ?? true;

    if (query.name) {
      conditions.push(`name = ?`);
      params.push(query.name);
    }
    if (query.type) {
      conditions.push(`type = ?`);
      params.push(query.type);
    }
    if (activeOnly) {
      conditions.push(`valid_until IS NULL`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = query.limit ?? 100;
    const rows = this.db
      .prepare(`SELECT * FROM entities ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, limit) as EntityRow[];

    return rows.map(toEntity);
  }

  /** Mark an entity as no longer valid (soft delete with temporal tracking). */
  invalidateEntity(id: string, reason?: string): void {
    this.runInTransaction(() => {
      const now = Date.now();
      this.db
        .prepare(`UPDATE entities SET valid_until = ?, updated_at = ? WHERE id = ? AND valid_until IS NULL`)
        .run(now, now, id);

      // Also invalidate outgoing/incoming edges
      this.db
        .prepare(
          `UPDATE edges SET valid_until = ? WHERE (from_id = ? OR to_id = ?) AND valid_until IS NULL`,
        )
        .run(now, id, id);

      removeEntityFts(this.db, id);

      if (reason) {
        // Store invalidation reason in meta for audit
        this.db
          .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
          .run(`invalidation:${id}`, JSON.stringify({ reason, timestamp: now }));
      }
    });
  }

  // -- Edge CRUD ------------------------------------------------------------

  addEdge(input: EdgeInput): Edge {
    const now = Date.now();
    const id = randomUUID();
    const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

    this.db
      .prepare(
        `INSERT INTO edges (id, from_id, to_id, relation, weight, metadata, valid_from, valid_until, created_at) ` +
          `VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        id,
        input.fromId,
        input.toId,
        input.relation,
        input.weight ?? 1.0,
        metadataJson,
        input.validFrom ?? now,
        now,
      );

    const row = this.db.prepare(`SELECT * FROM edges WHERE id = ?`).get(id) as EdgeRow;
    return toEdge(row);
  }

  invalidateEdge(id: string): void {
    const now = Date.now();
    this.db
      .prepare(`UPDATE edges SET valid_until = ? WHERE id = ? AND valid_until IS NULL`)
      .run(now, id);
  }

  findEdges(query: EdgeQuery): Edge[] {
    const conditions: string[] = [];
    const params: (string | number | null)[] = [];
    const activeOnly = query.activeOnly ?? true;
    const direction = query.direction ?? "both";

    if (query.entityId) {
      if (direction === "outgoing") {
        conditions.push(`from_id = ?`);
        params.push(query.entityId);
      } else if (direction === "incoming") {
        conditions.push(`to_id = ?`);
        params.push(query.entityId);
      } else {
        conditions.push(`(from_id = ? OR to_id = ?)`);
        params.push(query.entityId, query.entityId);
      }
    }
    if (query.relation) {
      conditions.push(`relation = ?`);
      params.push(query.relation);
    }
    if (activeOnly) {
      conditions.push(`valid_until IS NULL`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = query.limit ?? 100;
    const rows = this.db
      .prepare(`SELECT * FROM edges ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as EdgeRow[];

    return rows.map(toEdge);
  }

  // -- Graph traversal ------------------------------------------------------

  /** Get entities and edges within `depth` hops of the given entity. */
  getNeighbors(entityId: string, depth = 1): GraphSubset {
    const visitedEntities = new Set<string>([entityId]);
    const visitedEdges = new Set<string>();
    const resultEntities: Entity[] = [];
    const resultEdges: Edge[] = [];

    // Seed entity
    const root = this.getEntity(entityId);
    if (root) {
      resultEntities.push(root);
    }

    let frontier = [entityId];
    for (let d = 0; d < depth && frontier.length > 0; d++) {
      // Batch query: fetch all edges touching frontier nodes in one SQL
      const placeholders = frontier.map(() => "?").join(",");
      const edgeRows = this.db
        .prepare(
          `SELECT * FROM edges WHERE ` +
            `(from_id IN (${placeholders}) OR to_id IN (${placeholders})) ` +
            `AND valid_until IS NULL`,
        )
        .all(...frontier, ...frontier) as EdgeRow[];

      const newNeighborIds = new Set<string>();
      for (const row of edgeRows) {
        const edge = toEdge(row);
        if (visitedEdges.has(edge.id)) continue;
        visitedEdges.add(edge.id);
        resultEdges.push(edge);

        for (const candidateId of [edge.from_id, edge.to_id]) {
          if (!visitedEntities.has(candidateId)) {
            newNeighborIds.add(candidateId);
            visitedEntities.add(candidateId);
          }
        }
      }

      // Batch fetch new neighbor entities
      if (newNeighborIds.size > 0) {
        const ids = [...newNeighborIds];
        const ePlaceholders = ids.map(() => "?").join(",");
        const entityRows = this.db
          .prepare(`SELECT * FROM entities WHERE id IN (${ePlaceholders})`)
          .all(...ids) as EntityRow[];
        for (const row of entityRows) {
          resultEntities.push(toEntity(row));
        }
      }

      frontier = [...newNeighborIds];
    }

    return { entities: resultEntities, edges: resultEdges };
  }

  // -- Temporal queries -----------------------------------------------------

  /** Get all versions (active and invalidated) of an entity by name. */
  getEntityHistory(name: string): EntityVersion[] {
    const rows = this.db
      .prepare(`SELECT * FROM entities WHERE name = ? ORDER BY valid_from DESC`)
      .all(name) as EntityRow[];

    return rows.map((row, i) => ({
      entity: toEntity(row),
      supersededBy: i > 0 ? rows[i - 1]!.id : undefined,
    }));
  }

  /** Get all currently-valid entities, optionally filtered by type. */
  getActiveEntities(type?: EntityType): Entity[] {
    return this.findEntities({ type, activeOnly: true, limit: 500 });
  }

  // -- Episodes -------------------------------------------------------------

  recordEpisode(input: EpisodeInput): EpisodeRow {
    const id = randomUUID();
    const now = Date.now();
    const extractedIds = input.extractedEntityIds
      ? JSON.stringify(input.extractedEntityIds)
      : null;

    this.db
      .prepare(
        `INSERT INTO episodes (id, session_key, turn_index, content, extracted_entity_ids, timestamp) ` +
          `VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.sessionKey, input.turnIndex ?? null, input.content, extractedIds, now);

    return this.db.prepare(`SELECT * FROM episodes WHERE id = ?`).get(id) as EpisodeRow;
  }

  getEpisodes(sessionKey: string, limit = 50): EpisodeRow[] {
    return this.db
      .prepare(`SELECT * FROM episodes WHERE session_key = ? ORDER BY timestamp DESC LIMIT ?`)
      .all(sessionKey, limit) as EpisodeRow[];
  }

  // -- Stats ----------------------------------------------------------------

  stats(): { entities: number; edges: number; episodes: number; activeEntities: number } {
    const entities = (this.db.prepare(`SELECT COUNT(*) as c FROM entities`).get() as { c: number }).c;
    const edges = (this.db.prepare(`SELECT COUNT(*) as c FROM edges`).get() as { c: number }).c;
    const episodes = (this.db.prepare(`SELECT COUNT(*) as c FROM episodes`).get() as { c: number }).c;
    const activeEntities = (
      this.db.prepare(`SELECT COUNT(*) as c FROM entities WHERE valid_until IS NULL`).get() as { c: number }
    ).c;
    return { entities, edges, episodes, activeEntities };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toEntity(row: EntityRow): Entity {
  let embeddingVector: number[] | undefined;
  if (row.embedding) {
    try {
      embeddingVector = JSON.parse(row.embedding) as number[];
    } catch {
      // Corrupted embedding — skip
    }
  }
  return { ...row, embeddingVector };
}

function toEdge(row: EdgeRow): Edge {
  let metadataParsed: Record<string, unknown> | undefined;
  if (row.metadata) {
    try {
      metadataParsed = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      // Corrupted metadata — skip
    }
  }
  return { ...row, metadataParsed };
}
