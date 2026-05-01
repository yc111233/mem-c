/**
 * Query-aware hybrid retrieval pipeline.
 *
 * 4-stage pipeline:
 *   1. Query extraction — classify query intent (broad / focused / relation)
 *   2. Multi-signal retrieval — delegate to searchGraph for entity-centric search
 *   3. Focal rerank — boost highly-connected (focal) entities
 *   4. Evidence packing — fit results into a token budget
 *
 * Also integrates community reports for global/broad queries.
 */

import type { DatabaseSync } from "node:sqlite";
import type { MemoryGraphEngine } from "./graph-engine.js";
import { searchGraph, type GraphSearchResult } from "./graph-search.js";
import { getGlobalCommunityReports } from "./graph-community.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SearchMode = "entity" | "global" | "mixed" | "debug";

export type RetrievalOpts = {
  /** Search mode. Default "mixed" — auto-selects entity vs global. */
  mode?: SearchMode;
  /** Max entity results to return. Default 6. */
  maxResults?: number;
  /** Max tokens for the packed evidence. Default 800. */
  maxTokens?: number;
  /** Query embedding vector (caller provides). */
  queryEmbedding?: number[];
};

export type RetrievalEntity = {
  name: string;
  type: string;
  summary: string;
  score: number;
  evidence: string[];
};

export type RetrievalCommunityReport = {
  label: string;
  summary: string;
  relevance: number;
};

export type RetrievalResult = {
  mode: SearchMode;
  entities: RetrievalEntity[];
  communityReports: RetrievalCommunityReport[];
  scoreBreakdown: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Stage 1: Query extraction
// ---------------------------------------------------------------------------

type QueryHints = {
  entityHints: string[];
  isBroad: boolean;
  hasRelationIntent: boolean;
};

function extractQueryHints(query: string): QueryHints {
  // Capitalized words likely refer to entity names
  const entityHints = query.match(/[A-Z][a-z]+(?:\s[A-Z][a-z]+)*/g) ?? [];
  const broadKeywords = [
    "所有", "总结", "概述", "整体", "趋势",
    "all", "summary", "overview", "trend",
  ];
  const isBroad =
    broadKeywords.some((k) => query.toLowerCase().includes(k)) ||
    entityHints.length === 0;
  const relationKeywords = [
    "谁", "什么关系", "负责", "属于",
    "who", "relation", "responsible", "belongs",
  ];
  const hasRelationIntent = relationKeywords.some((k) =>
    query.toLowerCase().includes(k),
  );
  return { entityHints, isBroad, hasRelationIntent };
}

// ---------------------------------------------------------------------------
// Stage 2: Multi-signal retrieval
// ---------------------------------------------------------------------------

async function multiSignalRetrieve(
  db: DatabaseSync,
  engine: MemoryGraphEngine,
  query: string,
  opts: { queryEmbedding?: number[]; maxResults: number },
): Promise<GraphSearchResult[]> {
  return searchGraph(db, engine, query, {
    maxResults: opts.maxResults,
    queryEmbedding: opts.queryEmbedding,
    includeEdges: true,
    minScore: 0,
  });
}

// ---------------------------------------------------------------------------
// Stage 3: Focal rerank
// ---------------------------------------------------------------------------

function focalRerank(results: GraphSearchResult[]): GraphSearchResult[] {
  return [...results].sort((a, b) => {
    const boostA = 1 + Math.min(1, a.edges.length / 5) * 0.1;
    const boostB = 1 + Math.min(1, b.edges.length / 5) * 0.1;
    return b.score * boostB - a.score * boostA;
  });
}

// ---------------------------------------------------------------------------
// Stage 4: Evidence packing
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function packEvidence(
  results: GraphSearchResult[],
  maxTokens: number,
): { entities: RetrievalEntity[]; totalTokens: number } {
  const entities: RetrievalEntity[] = [];
  let totalTokens = 0;

  for (const hit of results) {
    const evidence = hit.edges.slice(0, 3).map((e) => {
      const isOutgoing = e.from_id === hit.entity.id;
      const arrow = isOutgoing ? "->" : "<-";
      return `${arrow} ${e.relation}`;
    });

    const summary = hit.entity.summary ?? "";
    const line = `${hit.entity.name}: ${summary}`;
    const tokens = estimateTokens(line);

    if (totalTokens + tokens > maxTokens) break;

    entities.push({
      name: hit.entity.name,
      type: hit.entity.type,
      summary,
      score: hit.score,
      evidence,
    });
    totalTokens += tokens;
  }

  return { entities, totalTokens };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function retrieve(
  db: DatabaseSync,
  engine: MemoryGraphEngine,
  query: string,
  opts?: RetrievalOpts,
): Promise<RetrievalResult> {
  const mode = opts?.mode ?? "mixed";
  const maxResults = opts?.maxResults ?? 6;
  const maxTokens = opts?.maxTokens ?? 800;

  // Stage 1
  const hints = extractQueryHints(query);

  // Debug mode: return raw hints + empty results
  if (mode === "debug") {
    return {
      mode: "debug",
      entities: [],
      communityReports: [],
      scoreBreakdown: { hints },
    };
  }

  // Global path: use community reports for broad queries
  if (mode === "global" || (mode === "mixed" && hints.isBroad)) {
    const reports = getGlobalCommunityReports(engine);
    const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);
    const relevant = reports.filter((r) => {
      const text = `${r.label} ${r.summary}`.toLowerCase();
      return queryWords.some((word) => text.includes(word));
    });

    // If no keyword match, return all (broad query)
    const filtered = relevant.length > 0 ? relevant : reports;

    return {
      mode: "global",
      entities: [],
      communityReports: filtered.slice(0, maxResults).map((r) => ({
        label: r.label,
        summary: r.summary,
        relevance: relevant.length > 0 ? 0.8 : 0.5,
      })),
      scoreBreakdown: {
        mode: "global",
        reportCount: filtered.length,
        matchedKeywords: relevant.length,
      },
    };
  }

  // Entity path
  const rawResults = await multiSignalRetrieve(db, engine, query, {
    queryEmbedding: opts?.queryEmbedding,
    maxResults: maxResults * 2,
  });

  // Stage 3
  const reranked = focalRerank(rawResults);

  // Stage 4
  const packed = packEvidence(reranked, maxTokens);

  // In mixed mode, also include community reports
  const communityReports: RetrievalCommunityReport[] = [];
  if (mode === "mixed") {
    const reports = getGlobalCommunityReports(engine);
    communityReports.push(
      ...reports.slice(0, 2).map((r) => ({
        label: r.label,
        summary: r.summary,
        relevance: 0.5,
      })),
    );
  }

  return {
    mode,
    entities: packed.entities,
    communityReports,
    scoreBreakdown: {
      mode,
      entityCount: packed.entities.length,
      reportCount: communityReports.length,
      estimatedTokens: packed.totalTokens,
    },
  };
}
