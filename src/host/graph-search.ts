import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { deserializeEmbedding, type Entity, type Edge, type MemoryGraphEngine } from "./graph-engine.js";
import { searchEntityFts } from "./graph-schema.js";
import { vecKnn } from "./graph-vec.js";

// ---------------------------------------------------------------------------
// Search result cache (LRU with TTL)
// ---------------------------------------------------------------------------

type CacheEntry = {
  results: GraphSearchResult[];
  timestamp: number;
};

let searchCache = new WeakMap<DatabaseSync, Map<string, CacheEntry>>();
const DEFAULT_CACHE_MAX = 128;
const DEFAULT_CACHE_TTL_MS = 30_000; // 30 seconds

function getCacheBucket(db: DatabaseSync): Map<string, CacheEntry> {
  const existing = searchCache.get(db);
  if (existing) return existing;
  const created = new Map<string, CacheEntry>();
  searchCache.set(db, created);
  return created;
}

function hashEmbedding(vec?: number[]): string {
  if (!vec || vec.length === 0) return "";
  return createHash("sha1")
    .update(Buffer.from(new Float32Array(vec).buffer))
    .digest("hex");
}

function makeCacheKey(query: string, opts?: GraphSearchOpts): string {
  const parts = [
    query,
    opts?.maxResults ?? 10,
    opts?.minScore ?? 0.1,
    [...(opts?.types ?? [])].sort().join(","),
    opts?.activeOnly ?? true,
    opts?.includeEdges ?? true,
    opts?.graphDepth ?? 1,
    opts?.vectorWeight ?? 0.5,
    opts?.ftsWeight ?? 0.3,
    opts?.graphWeight ?? 0.2,
    opts?.temporalDecayDays ?? 30,
    opts?.rerankFn ? "rerank" : "no-rerank",
    hashEmbedding(opts?.queryEmbedding),
  ];
  return parts.join("\x00");
}

function cacheGet(db: DatabaseSync, key: string, ttlMs: number): GraphSearchResult[] | null {
  const entry = searchCache.get(db)?.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ttlMs) {
    searchCache.get(db)?.delete(key);
    return null;
  }
  return entry.results;
}

function cacheSet(db: DatabaseSync, key: string, results: GraphSearchResult[]): void {
  const bucket = getCacheBucket(db);
  if (bucket.size >= DEFAULT_CACHE_MAX) {
    const oldest = bucket.keys().next().value;
    if (oldest !== undefined) bucket.delete(oldest);
  }
  bucket.set(key, { results, timestamp: Date.now() });
}

/** Clear the search result cache. Called automatically on entity and edge writes. */
export function clearSearchCache(db?: DatabaseSync): void {
  if (db) {
    searchCache.delete(db);
    return;
  }
  searchCache = new WeakMap<DatabaseSync, Map<string, CacheEntry>>();
}

// ---------------------------------------------------------------------------
// Search options and result types
// ---------------------------------------------------------------------------

export type GraphSearchOpts = {
  /** Max results to return. Default 10. */
  maxResults?: number;
  /** Min relevance score 0-1. Default 0.1. */
  minScore?: number;
  /** Entity types to include. Undefined = all. */
  types?: string[];
  /** Only return currently-valid entities. Default true. */
  activeOnly?: boolean;
  /** Include related edges in each result. Default true. */
  includeEdges?: boolean;
  /** Max BFS depth for graph expansion. Default 1. */
  graphDepth?: number;
  /** Weight for vector similarity. Default 0.5. */
  vectorWeight?: number;
  /** Weight for FTS score. Default 0.3. */
  ftsWeight?: number;
  /** Weight for graph connectivity score. Default 0.2. */
  graphWeight?: number;
  /** Temporal decay half-life in days. 0 = no decay. Default 30. */
  temporalDecayDays?: number;
  /** Query embedding vector (caller provides). */
  queryEmbedding?: number[];
  /** Cache TTL in ms. 0 = no cache. Default 30000 (30s). */
  cacheTtlMs?: number;
  /** Rerank function for search result reordering. */
  rerankFn?: (query: string, documents: string[]) => Promise<Array<{ index: number; score: number }>>;
};

export type GraphSearchResult = {
  entity: Entity;
  score: number;
  /** Breakdown of scoring components. */
  scoreBreakdown: {
    vector: number;
    fts: number;
    graph: number;
    temporal: number;
  };
  /** Related edges for this entity. */
  edges: Edge[];
  /** Related entity names (1-hop neighbors). */
  relatedNames: string[];
};

// ---------------------------------------------------------------------------
// Hybrid graph search
// ---------------------------------------------------------------------------

export async function searchGraph(
  db: DatabaseSync,
  engine: MemoryGraphEngine,
  query: string,
  opts?: GraphSearchOpts,
): Promise<GraphSearchResult[]> {
  const cacheTtlMs = opts?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  // Check cache
  if (cacheTtlMs > 0) {
    const cacheKey = makeCacheKey(query, opts);
    const cached = cacheGet(db, cacheKey, cacheTtlMs);
    if (cached) return cached;
  }

  const maxResults = opts?.maxResults ?? 10;
  const minScore = opts?.minScore ?? 0.1;
  const activeOnly = opts?.activeOnly ?? true;
  const includeEdges = opts?.includeEdges ?? true;
  const graphDepth = opts?.graphDepth ?? 1;
  const vectorWeight = opts?.vectorWeight ?? 0.5;
  const ftsWeight = opts?.ftsWeight ?? 0.3;
  const graphWeight = opts?.graphWeight ?? 0.2;
  const temporalDecayDays = opts?.temporalDecayDays ?? 30;
  // Auto-generate query embedding via engine's embedFn if not provided
  let queryEmbedding = opts?.queryEmbedding;
  if (!queryEmbedding && query.trim()) {
    // Prefer sync embedFn, fall back to async
    const syncEmbed = engine.getEmbedFn();
    const asyncEmbed = engine.getAsyncEmbedFn();
    if (syncEmbed) {
      try {
        queryEmbedding = syncEmbed(query);
      } catch {
        // Non-fatal: fall back to FTS-only search
      }
    } else if (asyncEmbed) {
      try {
        queryEmbedding = await asyncEmbed(query);
      } catch {
        // Non-fatal
      }
    }
  }

  // Candidate pool — gather from multiple retrieval paths
  const candidateScores = new Map<string, { vector: number; fts: number }>();
  const candidateLimit = maxResults * 4;

  // Path 1: FTS search
  const namespace = engine.getNamespace();
  try {
    const ftsResults = searchEntityFts(db, query, { limit: candidateLimit, namespace });
    if (ftsResults.length > 0) {
      // FTS5 BM25 rank is negative; more negative = better match.
      // Normalize: score = -rank / (-rank + 1) maps (-inf,0) → (0,1)
      // Works well even with small document sets where relative normalization fails.
      for (const hit of ftsResults) {
        const rawRank = hit.rank; // negative
        const normalizedScore = Math.min(1, Math.max(0, -rawRank / (-rawRank + 1)));

        const existing = candidateScores.get(hit.id);
        if (existing) {
          existing.fts = normalizedScore;
        } else {
          candidateScores.set(hit.id, { vector: 0, fts: normalizedScore });
        }
      }
    }
  } catch {
    // FTS may be unavailable
  }

  // Path 2: Vector similarity (if embedding provided)
  if (queryEmbedding && queryEmbedding.length > 0) {
    const vectorHits = vectorSearchEntities(db, engine, queryEmbedding, candidateLimit, activeOnly);
    for (const hit of vectorHits) {
      const existing = candidateScores.get(hit.id);
      if (existing) {
        existing.vector = hit.similarity;
      } else {
        candidateScores.set(hit.id, { vector: hit.similarity, fts: 0 });
      }
    }
  }

  // If no candidates found, do a fallback LIKE search (name > summary)
  if (candidateScores.size === 0) {
    // Escape LIKE wildcards in the query
    const escaped = query.replace(/[%_\\]/g, (ch) => `\\${ch}`);
    const likePattern = `%${escaped}%`;
    const validClause = activeOnly ? `AND valid_until IS NULL` : "";
    const nsClause = namespace !== null
      ? `AND namespace = ?`
      : `AND namespace IS NULL`;
    const nsParams = namespace !== null ? [namespace] : [];

    const nameHits = db
      .prepare(`SELECT id FROM entities WHERE name LIKE ? ESCAPE '\\' ${nsClause} ${validClause} LIMIT ?`)
      .all(likePattern, ...nsParams, candidateLimit) as Array<{ id: string }>;
    for (const row of nameHits) {
      candidateScores.set(row.id, { vector: 0, fts: 0.5 });
    }

    const summaryHits = db
      .prepare(`SELECT id FROM entities WHERE summary LIKE ? ESCAPE '\\' ${nsClause} ${validClause} LIMIT ?`)
      .all(likePattern, ...nsParams, candidateLimit) as Array<{ id: string }>;
    for (const row of summaryHits) {
      if (!candidateScores.has(row.id)) {
        candidateScores.set(row.id, { vector: 0, fts: 0.2 });
      }
    }
  }

  // Filter by type if specified
  const typesFilter = opts?.types;

  // Score and rank candidates
  const now = Date.now();
  const results: GraphSearchResult[] = [];

  for (const [entityId, scores] of candidateScores) {
    const entity = engine.getEntity(entityId);
    if (!entity) continue;
    if (activeOnly && entity.valid_until !== null) continue;
    if (typesFilter && !typesFilter.includes(entity.type)) continue;

    // Temporal decay: reduce score for older entities
    let temporalFactor = 1.0;
    if (temporalDecayDays > 0) {
      const ageDays = (now - entity.updated_at) / (1000 * 60 * 60 * 24);
      const halfLife = temporalDecayDays;
      temporalFactor = Math.pow(0.5, ageDays / halfLife);
    }

    // Graph connectivity score: how connected is this entity?
    let graphScore = 0;
    let edges: Edge[] = [];
    const relatedNames: string[] = [];

    if (graphWeight > 0 || includeEdges) {
      const neighbors = engine.getNeighbors(entityId, graphDepth);
      edges = neighbors.edges;
      // Normalize edge count to 0-1 (cap at 10 edges = score 1.0)
      graphScore = Math.min(1, edges.length / 10);

      for (const e of neighbors.entities) {
        if (e.id !== entityId) {
          relatedNames.push(e.name);
        }
      }
    }

    // Weighted combination
    const rawScore =
      scores.vector * vectorWeight +
      scores.fts * ftsWeight +
      graphScore * graphWeight;

    const finalScore = rawScore * temporalFactor * entity.confidence;

    if (finalScore < minScore) continue;

    results.push({
      entity,
      score: finalScore,
      scoreBreakdown: {
        vector: scores.vector,
        fts: scores.fts,
        graph: graphScore,
        temporal: temporalFactor,
      },
      edges: includeEdges ? edges : [],
      relatedNames,
    });
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  // MMR-style diversity: avoid returning too many entities of the same type
  let finalResults = applyDiversityFilter(results, maxResults);

  // Optional rerank step
  if (opts?.rerankFn && finalResults.length > 1) {
    try {
      const documents = finalResults.map(
        (r) => `${r.entity.name}: ${r.entity.summary ?? r.entity.type}`,
      );
      const reranked = await opts.rerankFn(query, documents);
      if (reranked.length > 0) {
        const rerankedResults: GraphSearchResult[] = [];
        for (const item of reranked) {
          if (item.index >= 0 && item.index < finalResults.length) {
            const original = finalResults[item.index]!;
            rerankedResults.push({
              ...original,
              score: item.score,
            });
          }
        }
        // Only use reranked results if we got a reasonable number back
        if (rerankedResults.length >= Math.ceil(finalResults.length * 0.5)) {
          finalResults = rerankedResults;
        }
      }
    } catch {
      // Rerank failure is non-fatal; use original ordering
    }
  }

  if (cacheTtlMs > 0) {
    const cacheKey = makeCacheKey(query, opts);
    cacheSet(db, cacheKey, finalResults);
  }

  return finalResults;
}

// ---------------------------------------------------------------------------
// Vector search helper (uses sqlite-vec if available)
// ---------------------------------------------------------------------------

type VectorHit = { id: string; similarity: number };

// Full scan limit used when sqlite-vec is not available
const VECTOR_SCAN_LIMIT = 5000;

function vectorSearchEntities(
  db: DatabaseSync,
  engine: MemoryGraphEngine,
  queryEmbedding: number[],
  limit: number,
  activeOnly: boolean,
): VectorHit[] {
  const namespace = engine.getNamespace();

  // Path 1: sqlite-vec ANN index (fast path)
  // vec0 doesn't support metadata, so filter by namespace after KNN
  if (engine.vecAvailable()) {
    try {
      const knnResults = vecKnn(db, queryEmbedding, limit * 4, true);
      if (knnResults.length > 0) {
        const hits: VectorHit[] = [];
        for (const r of knnResults) {
          const entity = engine.getEntity(r.id);
          if (!entity) continue;
          if (activeOnly && entity.valid_until !== null) continue;
          if (namespace !== null && entity.namespace !== namespace) continue;
          if (namespace === null && entity.namespace !== null) continue;
          const similarity = 1 / (1 + r.distance);
          hits.push({ id: r.id, similarity });
          if (hits.length >= limit) break;
        }
        hits.sort((a, b) => b.similarity - a.similarity);
        return hits;
      }
    } catch {
      // Fall through to full scan
    }
  }

  // Path 2: Full scan fallback (original implementation)
  try {
    const scanLimit = Math.min(VECTOR_SCAN_LIMIT, Math.max(limit * 2, 100));
    const nsClause = namespace !== null
      ? `AND namespace = ?`
      : `AND namespace IS NULL`;
    const nsParams = namespace !== null ? [namespace] : [];
    const rows = db
      .prepare(
        `SELECT id, embedding FROM entities WHERE embedding IS NOT NULL ` +
          `${nsClause} ` +
          `${activeOnly ? "AND valid_until IS NULL " : ""}` +
          `ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...nsParams, scanLimit) as Array<{ id: string; embedding: string | Buffer }>;

    const hits: VectorHit[] = [];
    for (const row of rows) {
      try {
        let stored: number[];
        if (typeof row.embedding === "string") {
          stored = JSON.parse(row.embedding) as number[];
        } else {
          stored = deserializeEmbedding(row.embedding as Buffer);
        }
        const sim = cosineSimilarity(queryEmbedding, stored);
        if (sim > 0) {
          hits.push({ id: row.id, similarity: sim });
        }
      } catch {
        continue;
      }
    }

    hits.sort((a, b) => b.similarity - a.similarity);
    return hits.slice(0, limit);
  } catch {
    return [];
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

// ---------------------------------------------------------------------------
// Diversity filter (simple type-based MMR)
// ---------------------------------------------------------------------------

function applyDiversityFilter(
  results: GraphSearchResult[],
  maxResults: number,
): GraphSearchResult[] {
  if (results.length <= maxResults) return results;

  const selected: GraphSearchResult[] = [];
  const typeCounts = new Map<string, number>();
  const maxPerType = Math.max(2, Math.ceil(maxResults / 3));

  for (const result of results) {
    if (selected.length >= maxResults) break;
    const count = typeCounts.get(result.entity.type) ?? 0;
    if (count >= maxPerType) continue;
    selected.push(result);
    typeCounts.set(result.entity.type, count + 1);
  }

  // Fill remaining slots if diversity filter was too aggressive
  if (selected.length < maxResults) {
    const selectedIds = new Set(selected.map((r) => r.entity.id));
    for (const result of results) {
      if (selected.length >= maxResults) break;
      if (!selectedIds.has(result.entity.id)) {
        selected.push(result);
      }
    }
  }

  return selected;
}
