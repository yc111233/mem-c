import type { DatabaseSync } from "node:sqlite";
import type { Entity, Edge, MemoryGraphEngine } from "./graph-engine.js";
import { searchEntityFts, type EntityRow } from "./graph-schema.js";

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

export function searchGraph(
  db: DatabaseSync,
  engine: MemoryGraphEngine,
  query: string,
  opts?: GraphSearchOpts,
): GraphSearchResult[] {
  const maxResults = opts?.maxResults ?? 10;
  const minScore = opts?.minScore ?? 0.1;
  const activeOnly = opts?.activeOnly ?? true;
  const includeEdges = opts?.includeEdges ?? true;
  const graphDepth = opts?.graphDepth ?? 1;
  const vectorWeight = opts?.vectorWeight ?? 0.5;
  const ftsWeight = opts?.ftsWeight ?? 0.3;
  const graphWeight = opts?.graphWeight ?? 0.2;
  const temporalDecayDays = opts?.temporalDecayDays ?? 30;
  const queryEmbedding = opts?.queryEmbedding;

  // Candidate pool — gather from multiple retrieval paths
  const candidateScores = new Map<string, { vector: number; fts: number }>();
  const candidateLimit = maxResults * 4;

  // Path 1: FTS search
  try {
    const ftsResults = searchEntityFts(db, query, { limit: candidateLimit });
    for (const hit of ftsResults) {
      // FTS5 rank is negative; normalize to 0-1 range
      const normalizedScore = Math.min(1, Math.max(0, -hit.rank / 10));
      const existing = candidateScores.get(hit.id);
      if (existing) {
        existing.fts = normalizedScore;
      } else {
        candidateScores.set(hit.id, { vector: 0, fts: normalizedScore });
      }
    }
  } catch {
    // FTS may be unavailable
  }

  // Path 2: Vector similarity (if embedding provided)
  if (queryEmbedding && queryEmbedding.length > 0) {
    const vectorHits = vectorSearchEntities(db, queryEmbedding, candidateLimit, activeOnly);
    for (const hit of vectorHits) {
      const existing = candidateScores.get(hit.id);
      if (existing) {
        existing.vector = hit.similarity;
      } else {
        candidateScores.set(hit.id, { vector: hit.similarity, fts: 0 });
      }
    }
  }

  // If no candidates found, do a fallback name LIKE search
  if (candidateScores.size === 0) {
    const likePattern = `%${query}%`;
    const validClause = activeOnly ? `AND valid_until IS NULL` : "";
    const fallbackRows = db
      .prepare(
        `SELECT id FROM entities WHERE (name LIKE ? OR summary LIKE ?) ${validClause} LIMIT ?`,
      )
      .all(likePattern, likePattern, candidateLimit) as Array<{ id: string }>;
    for (const row of fallbackRows) {
      candidateScores.set(row.id, { vector: 0, fts: 0.3 });
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
  return applyDiversityFilter(results, maxResults);
}

// ---------------------------------------------------------------------------
// Vector search helper (uses sqlite-vec if available)
// ---------------------------------------------------------------------------

type VectorHit = { id: string; similarity: number };

function vectorSearchEntities(
  db: DatabaseSync,
  queryEmbedding: number[],
  limit: number,
  activeOnly: boolean,
): VectorHit[] {
  // Try sqlite-vec virtual table first
  try {
    const validClause = activeOnly ? `AND e.valid_until IS NULL` : "";
    // sqlite-vec stores vectors in the embedding column as JSON arrays
    // We compute cosine similarity manually for portability
    const rows = db
      .prepare(
        `SELECT id, embedding FROM entities WHERE embedding IS NOT NULL ${activeOnly ? "AND valid_until IS NULL" : ""} LIMIT ?`,
      )
      .all(limit * 2) as Array<{ id: string; embedding: string }>;

    const hits: VectorHit[] = [];
    for (const row of rows) {
      try {
        const stored = JSON.parse(row.embedding) as number[];
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
