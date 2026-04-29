import { createHash, randomUUID } from "node:crypto";
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
import { vecUpsert, vecRemove } from "./graph-vec.js";
import { clearSearchCache } from "./graph-search.js";
import { GraphEventEmitter } from "./graph-events.js";

// ---------------------------------------------------------------------------
// Embedding serialization (Float32Array ↔ Buffer)
// ---------------------------------------------------------------------------

export function serializeEmbedding(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

export function deserializeEmbedding(blob: Buffer): number[] {
  const f32 = new Float32Array(new Uint8Array(blob).buffer);
  return Array.from(f32);
}

// ---------------------------------------------------------------------------
// Entity name normalization
// ---------------------------------------------------------------------------

export function normalizeEntityName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Embed function type
// ---------------------------------------------------------------------------

export type EmbedFn = (text: string) => number[];

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

export type PathStep = {
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  relation: string;
};

export type PathResult = {
  steps: PathStep[];
  length: number;
};

export type FindPathsOpts = {
  /** Max BFS depth. Default 3. */
  maxDepth?: number;
  /** Max paths to return. Default 10. */
  maxPaths?: number;
};

export type MemoryGraphEngineOpts = {
  embedFn?: EmbedFn;
  /** Async embedding function (for modelConfig-based embedding). Takes priority over sync embedFn. */
  asyncEmbedFn?: (text: string) => Promise<number[]>;
  namespace?: string;
};

export type EntityVersion = {
  entity: Entity;
  supersededBy?: string;
};

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class MemoryGraphEngine {
  private readonly embedFn?: EmbedFn;
  private readonly asyncEmbedFn?: (text: string) => Promise<number[]>;
  private readonly namespace: string | null;
  private readonly events = new GraphEventEmitter();

  constructor(private readonly db: DatabaseSync, opts?: MemoryGraphEngineOpts) {
    this.embedFn = opts?.embedFn;
    this.asyncEmbedFn = opts?.asyncEmbedFn;
    this.namespace = opts?.namespace ?? null;
  }

  /** Expose the underlying database for advanced queries (e.g. episode lookups). */
  getDb(): DatabaseSync {
    return this.db;
  }

  /** Get the configured embedding function, if any. */
  getEmbedFn(): EmbedFn | undefined {
    return this.embedFn;
  }

  /** Get the configured async embedding function, if any. */
  getAsyncEmbedFn(): ((text: string) => Promise<number[]>) | undefined {
    return this.asyncEmbedFn;
  }

  /** Get the event emitter for subscribing to graph lifecycle events. */
  getEvents(): GraphEventEmitter {
    return this.events;
  }

  private _vecAvailable = false;

  setVecAvailable(available: boolean): void {
    this._vecAvailable = available;
  }

  vecAvailable(): boolean {
    return this._vecAvailable;
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

      // Auto-generate embedding via hook if not provided
      const newHash = computeContentHash(input.name, input.summary);
      let embedding = input.embedding;
      if (!embedding && this.embedFn) {
        // Only re-embed if content actually changed
        const existingHash = this.db
          .prepare(`SELECT content_hash FROM entities WHERE name = ? AND type = ? AND valid_until IS NULL AND (namespace = ? OR (namespace IS NULL AND ? IS NULL)) LIMIT 1`)
          .get(input.name, input.type, this.namespace, this.namespace) as { content_hash: string | null } | undefined;
        const shouldReembed = !existingHash || existingHash.content_hash !== newHash;
        if (shouldReembed) {
          try {
            const text = input.name + (input.summary ? " " + input.summary : "");
            embedding = this.embedFn(text);
          } catch {
            // Non-fatal
          }
        } else {
          // Content unchanged — keep existing embedding, skip embedFn
          embedding = undefined;
        }
      }
      const embeddingBlob = embedding ? serializeEmbedding(embedding) : null;

      // Try to find existing active entity with same name+type (scoped by namespace)
      let existing = this.db
        .prepare(
          `SELECT * FROM entities WHERE name = ? AND type = ? AND valid_until IS NULL AND (namespace = ? OR (namespace IS NULL AND ? IS NULL)) LIMIT 1`,
        )
        .get(input.name, input.type, this.namespace, this.namespace) as EntityRow | undefined;

      // Fallback: try normalized alias lookup (join with entities to filter by type)
      if (!existing) {
        const normalized = normalizeEntityName(input.name);
        existing = this.db
          .prepare(
            `SELECT e.* FROM entity_aliases a ` +
              `JOIN entities e ON e.id = a.entity_id ` +
              `WHERE a.alias = ? AND e.type = ? AND e.valid_until IS NULL AND (e.namespace = ? OR (e.namespace IS NULL AND ? IS NULL)) LIMIT 1`,
          )
          .get(normalized, input.type, this.namespace, this.namespace) as EntityRow | undefined;
      }

      if (existing) {
        // Update existing entity
        this.db
          .prepare(
            `UPDATE entities SET summary = COALESCE(?, summary), embedding = COALESCE(?, embedding), ` +
              `confidence = ?, source = ?, updated_at = ?, content_hash = ? WHERE id = ?`,
          )
          .run(
            input.summary ?? null,
            embeddingBlob,
            input.confidence ?? existing.confidence,
            input.source ?? existing.source,
            now,
            newHash,
            existing.id,
          );

        // Ensure alias exists for the input name variant
        this._ensureAlias(existing.id, input.name, now);

        const updated = this.db
          .prepare(`SELECT * FROM entities WHERE id = ?`)
          .get(existing.id) as EntityRow;

        syncEntityFts(this.db, updated);
        if (this._vecAvailable && embedding) {
          vecUpsert(this.db, updated.id, embedding, true);
        }
        clearSearchCache();
        const result = { ...toEntity(updated), isNew: false };
        this.events.emit("entity:updated", result);
        return result;
      }

      // Insert new entity
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO entities (id, name, type, summary, embedding, confidence, source, valid_from, valid_until, created_at, updated_at, content_hash, namespace) ` +
            `VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.type,
          input.summary ?? null,
          embeddingBlob,
          input.confidence ?? 1.0,
          input.source ?? "auto",
          input.validFrom ?? now,
          now,
          now,
          newHash,
          this.namespace,
        );

      // Register normalized alias
      this._ensureAlias(id, input.name, now);

      const row = this.db.prepare(`SELECT * FROM entities WHERE id = ?`).get(id) as EntityRow;
      syncEntityFts(this.db, row);
      if (this._vecAvailable && embedding) {
        vecUpsert(this.db, row.id, embedding, true);
      }
      clearSearchCache();
      const result = { ...toEntity(row), isNew: true };
      this.events.emit("entity:created", result);
      return result;
    });
  }

  /**
   * Async variant of upsertEntity that supports async embedding.
   * Pre-computes embedding via asyncEmbedFn, then delegates to sync upsertEntity.
   */
  async asyncUpsertEntity(input: EntityInput): Promise<Entity & { isNew: boolean }> {
    if (!input.embedding && this.asyncEmbedFn) {
      const newHash = computeContentHash(input.name, input.summary);
      const existingHash = this.db
        .prepare(
          `SELECT content_hash FROM entities WHERE name = ? AND type = ? AND valid_until IS NULL AND (namespace = ? OR (namespace IS NULL AND ? IS NULL)) LIMIT 1`,
        )
        .get(input.name, input.type, this.namespace, this.namespace) as
        | { content_hash: string | null }
        | undefined;

      const shouldReembed = !existingHash || existingHash.content_hash !== newHash;
      if (shouldReembed) {
        try {
          const text = input.name + (input.summary ? " " + input.summary : "");
          input = { ...input, embedding: await this.asyncEmbedFn(text) };
        } catch {
          // Non-fatal: proceed without embedding
        }
      }
    }
    return this.upsertEntity(input);
  }

  getEntity(id: string): Entity | null {
    const row = this.db
      .prepare(`SELECT * FROM entities WHERE id = ? AND (namespace = ? OR (namespace IS NULL AND ? IS NULL))`)
      .get(id, this.namespace, this.namespace) as EntityRow | undefined;
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
    if (this.namespace !== null) {
      conditions.push(`(namespace = ? OR namespace IS NULL)`);
      params.push(this.namespace);
    } else {
      conditions.push(`namespace IS NULL`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = query.limit ?? 100;
    const rows = this.db
      .prepare(`SELECT * FROM entities ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, limit) as EntityRow[];

    // If searching by name and no results, try alias lookup
    if (rows.length === 0 && query.name) {
      const normalized = normalizeEntityName(query.name);
      const aliasRows = this.db
        .prepare(`SELECT entity_id FROM entity_aliases WHERE alias = ?`)
        .all(normalized) as Array<{ entity_id: string }>;
      if (aliasRows.length > 0) {
        const ids = aliasRows.map((r) => r.entity_id);
        const placeholders = ids.map(() => "?").join(",");
        const aliasConds: string[] = [`id IN (${placeholders})`];
        const aliasParams: (string | number | null)[] = [...ids];
        if (query.type) {
          aliasConds.push(`type = ?`);
          aliasParams.push(query.type);
        }
        if (activeOnly) {
          aliasConds.push(`valid_until IS NULL`);
        }
        if (this.namespace !== null) {
          aliasConds.push(`(namespace = ? OR namespace IS NULL)`);
          aliasParams.push(this.namespace);
        } else {
          aliasConds.push(`namespace IS NULL`);
        }
        const aliasWhere = `WHERE ${aliasConds.join(" AND ")}`;
        const aliasEntities = this.db
          .prepare(`SELECT * FROM entities ${aliasWhere} ORDER BY updated_at DESC LIMIT ?`)
          .all(...aliasParams, limit) as EntityRow[];
        return aliasEntities.map(toEntity);
      }
    }

    return rows.map(toEntity);
  }

  /** Register a normalized alias for an entity (internal helper). */
  private _ensureAlias(entityId: string, name: string, now: number): void {
    const normalized = normalizeEntityName(name);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO entity_aliases (alias, entity_id, created_at) VALUES (?, ?, ?)`,
      )
      .run(normalized, entityId, now);
  }

  /** Add a custom alias for an entity. */
  addAlias(entityId: string, alias: string): void {
    const normalized = normalizeEntityName(alias);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO entity_aliases (alias, entity_id, created_at) VALUES (?, ?, ?)`,
      )
      .run(normalized, entityId, Date.now());
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
      clearSearchCache();

      this.events.emit("entity:invalidated", id);

      if (this._vecAvailable) {
        vecRemove(this.db, id, true);
      }

      if (reason) {
        // Store invalidation reason in meta for audit
        this.db
          .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
          .run(`invalidation:${id}`, JSON.stringify({ reason, timestamp: now }));
      }
    });
  }

  /** Increment access counter and update last_accessed_at for an entity. */
  touchEntity(id: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE entities SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
      )
      .run(now, id);
  }

  /** Update confidence for an entity (used by consolidation). */
  updateConfidence(id: string, confidence: number): void {
    const now = Date.now();
    this.db
      .prepare(`UPDATE entities SET confidence = ?, updated_at = ? WHERE id = ?`)
      .run(Math.max(0.1, confidence), now, id);
  }

  /**
   * Reassign all active edges from one entity to another.
   * Used during entity merge to redirect relationships.
   */
  reassignEdges(fromEntityId: string, toEntityId: string): number {
    let count = 0;
    const now = Date.now();
    // Redirect outgoing edges
    const r1 = this.db
      .prepare(
        `UPDATE edges SET from_id = ? WHERE from_id = ? AND valid_until IS NULL AND to_id != ?`,
      )
      .run(toEntityId, fromEntityId, toEntityId);
    count += (r1 as { changes?: number }).changes ?? 0;
    // Redirect incoming edges
    const r2 = this.db
      .prepare(
        `UPDATE edges SET to_id = ? WHERE to_id = ? AND valid_until IS NULL AND from_id != ?`,
      )
      .run(toEntityId, fromEntityId, toEntityId);
    count += (r2 as { changes?: number }).changes ?? 0;
    // Invalidate self-loops that may have been created
    this.db
      .prepare(
        `UPDATE edges SET valid_until = ? WHERE from_id = ? AND to_id = ? AND valid_until IS NULL`,
      )
      .run(now, toEntityId, toEntityId);
    return count;
  }

  /**
   * Get active entities sorted by importance score.
   * Importance combines recency, degree centrality, access frequency, and confidence.
   */
  getEntitiesByImportance(opts?: {
    maxEntities?: number;
    type?: EntityType;
  }): Array<Entity & { importance: number }> {
    const maxEntities = opts?.maxEntities ?? 100;
    const entities = this.getActiveEntities(opts?.type);
    if (entities.length === 0) return [];

    // Batch edge counts in one query
    const edgeCounts = new Map<string, number>();
    const rows = this.db
      .prepare(
        `SELECT id, cnt FROM (` +
          `SELECT from_id AS id, COUNT(*) AS cnt FROM edges WHERE valid_until IS NULL GROUP BY from_id ` +
          `UNION ALL ` +
          `SELECT to_id AS id, COUNT(*) AS cnt FROM edges WHERE valid_until IS NULL GROUP BY to_id` +
        `)`,
      )
      .all() as Array<{ id: string; cnt: number }>;
    for (const r of rows) {
      edgeCounts.set(r.id, (edgeCounts.get(r.id) ?? 0) + r.cnt);
    }

    const now = Date.now();
    const scored = entities.map((entity) => ({
      ...entity,
      importance: computeImportance(entity, edgeCounts.get(entity.id) ?? 0, now),
    }));

    scored.sort((a, b) => b.importance - a.importance);
    return scored.slice(0, maxEntities);
  }

  // -- Edge CRUD ------------------------------------------------------------

  addEdge(input: EdgeInput): Edge {
    return this.runInTransaction(() => {
      const now = Date.now();
      const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;
      const newWeight = input.weight ?? 1.0;

      // Dedup: check for existing active edge with same (from, to, relation) in same namespace
      const existing = this.db
        .prepare(
          `SELECT * FROM edges WHERE from_id = ? AND to_id = ? AND relation = ? AND valid_until IS NULL AND (namespace = ? OR (namespace IS NULL AND ? IS NULL)) LIMIT 1`,
        )
        .get(input.fromId, input.toId, input.relation, this.namespace, this.namespace) as EdgeRow | undefined;

      if (existing) {
        // Update weight (keep the higher value) and metadata
        const updatedWeight = Math.max(existing.weight, newWeight);
        this.db
          .prepare(`UPDATE edges SET weight = ?, metadata = COALESCE(?, metadata) WHERE id = ?`)
          .run(updatedWeight, metadataJson, existing.id);
        const row = this.db.prepare(`SELECT * FROM edges WHERE id = ?`).get(existing.id) as EdgeRow;
        const edgeResult = toEdge(row);
        this.events.emit("edge:updated", edgeResult);
        return edgeResult;
      }

      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO edges (id, from_id, to_id, relation, weight, metadata, valid_from, valid_until, created_at, namespace) ` +
            `VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          id,
          input.fromId,
          input.toId,
          input.relation,
          newWeight,
          metadataJson,
          input.validFrom ?? now,
          now,
          this.namespace,
        );

      const row = this.db.prepare(`SELECT * FROM edges WHERE id = ?`).get(id) as EdgeRow;
      const edgeResult = toEdge(row);
      this.events.emit("edge:created", edgeResult);
      return edgeResult;
    });
  }

  /** Batch upsert multiple entities in a single transaction. */
  upsertEntities(inputs: EntityInput[]): Array<Entity & { isNew: boolean }> {
    return this.runInTransaction(() => inputs.map((input) => this.upsertEntity(input)));
  }

  /** Batch create multiple edges in a single transaction. */
  addEdges(inputs: EdgeInput[]): Edge[] {
    return this.runInTransaction(() => inputs.map((input) => this.addEdge(input)));
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
    if (this.namespace !== null) {
      conditions.push(`(namespace = ? OR namespace IS NULL)`);
      params.push(this.namespace);
    } else {
      conditions.push(`namespace IS NULL`);
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

  /**
   * Find all paths between two entities up to maxDepth hops.
   * Uses BFS with path tracking. Returns paths sorted by length.
   */
  findPaths(
    fromId: string,
    toId: string,
    opts?: FindPathsOpts,
  ): PathResult[] {
    const maxDepth = opts?.maxDepth ?? 3;
    const maxPaths = opts?.maxPaths ?? 10;

    if (fromId === toId) return [];

    const fromEntity = this.getEntity(fromId);
    const toEntity = this.getEntity(toId);
    if (!fromEntity || !toEntity) return [];

    const results: PathResult[] = [];

    // BFS queue: each entry is [currentEntityId, pathSoFar]
    type QueueEntry = [string, PathStep[]];
    const queue: QueueEntry[] = [[fromId, []]];

    while (queue.length > 0 && results.length < maxPaths) {
      const [currentId, path] = queue.shift()!;

      if (path.length >= maxDepth) continue;

      // Get all edges touching this entity
      const edges = this.findEdges({
        entityId: currentId,
        activeOnly: true,
        limit: 100,
      });

      for (const edge of edges) {
        const isOutgoing = edge.from_id === currentId;
        const neighborId = isOutgoing ? edge.to_id : edge.from_id;

        // Skip if this entity is already in the current path (avoid cycles)
        const pathEntityIds = new Set([fromId, ...path.map((s) => s.toId)]);
        if (pathEntityIds.has(neighborId)) continue;

        const neighborEntity = this.getEntity(neighborId);
        const neighborName = neighborEntity?.name ?? neighborId.slice(0, 8);
        const fromName = path.length === 0
          ? fromEntity.name
          : path[path.length - 1]!.toName;

        const step: PathStep = {
          fromId: currentId,
          fromName,
          toId: neighborId,
          toName: neighborName,
          relation: edge.relation,
        };

        const newPath = [...path, step];

        if (neighborId === toId) {
          results.push({ steps: newPath, length: newPath.length });
        } else if (newPath.length < maxDepth) {
          queue.push([neighborId, newPath]);
        }
      }
    }

    // Sort by length (shortest first)
    results.sort((a, b) => a.length - b.length);
    return results.slice(0, maxPaths);
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
        `INSERT INTO episodes (id, session_key, turn_index, content, extracted_entity_ids, timestamp, namespace) ` +
          `VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.sessionKey, input.turnIndex ?? null, input.content, extractedIds, now, this.namespace);

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

/**
 * Compute a composite importance score for an entity.
 * Combines recency, degree centrality, access frequency, and confidence.
 */
export function computeImportance(entity: Entity, edgeCount: number, now: number): number {
  const ageDays = (now - entity.updated_at) / 86_400_000;
  const recency = Math.pow(0.5, ageDays / 30); // 30-day half-life

  const degree = Math.min(1, edgeCount / 10); // capped at 10 edges

  const accessDays =
    entity.last_accessed_at > 0
      ? (now - entity.last_accessed_at) / 86_400_000
      : 999;
  const accessScore =
    entity.access_count > 0
      ? Math.min(1, Math.log2(entity.access_count + 1) / 5) *
        Math.pow(0.5, accessDays / 14)
      : 0;

  return 0.3 * recency + 0.3 * degree + 0.25 * accessScore + 0.15 * entity.confidence;
}

function computeContentHash(name: string, summary?: string | null): string {
  const content = name + "\0" + (summary ?? "");
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function toEntity(row: EntityRow): Entity {
  let embeddingVector: number[] | undefined;
  if (row.embedding) {
    try {
      if (typeof row.embedding === "string") {
        // Legacy JSON TEXT format (pre-migration)
        embeddingVector = JSON.parse(row.embedding) as number[];
      } else {
        // BLOB storage (new format) — Buffer at runtime
        embeddingVector = deserializeEmbedding(row.embedding);
      }
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
