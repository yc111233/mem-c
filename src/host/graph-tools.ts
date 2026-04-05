/**
 * Agent tool definitions for the memory graph.
 *
 * These are plain functions that can be registered as agent tools by the
 * memory plugin. Each function takes structured input and returns a
 * JSON-serializable result. The memory plugin is responsible for wiring
 * them into the actual tool registry.
 */

import type { DatabaseSync } from "node:sqlite";
import type { MemoryGraphEngine, EntityInput } from "./graph-engine.js";
import { consolidateGraph, type ConsolidationResult } from "./graph-consolidator.js";
import {
  buildL1Context,
  buildL2Context,
  formatL1AsSearchContext,
  formatL2AsDetail,
  type L2DetailLevel,
} from "./graph-context-loader.js";

// ---------------------------------------------------------------------------
// Tool: memory_graph_search
// ---------------------------------------------------------------------------

export type MemoryGraphSearchInput = {
  query: string;
  types?: string[];
  maxResults?: number;
  includeRelations?: boolean;
  /** Compact mode: omit relations from L1 output to save tokens. */
  compact?: boolean;
};

export type MemoryGraphSearchOutput = {
  results: Array<{
    name: string;
    type: string;
    summary: string | null;
    score: number;
    relations: string[];
  }>;
  formatted: string;
};

export function memoryGraphSearch(
  db: DatabaseSync,
  engine: MemoryGraphEngine,
  input: MemoryGraphSearchInput,
  queryEmbedding?: number[],
): MemoryGraphSearchOutput {
  const l1 = buildL1Context(db, engine, input.query, {
    maxResults: input.maxResults ?? 6,
    compact: input.compact,
    queryEmbedding,
    types: input.types,
  });

  const results = l1.results.map((r) => ({
    name: r.name,
    type: r.type,
    summary: r.summary || null,
    score: r.score,
    relations: input.includeRelations !== false ? r.relations : [],
  }));

  // Touch top search results to track access frequency (lightweight name lookups)
  for (const r of l1.results.slice(0, 3)) {
    const match = engine.findEntities({ name: r.name, activeOnly: true, limit: 1 });
    if (match[0]) engine.touchEntity(match[0].id);
  }

  return {
    results,
    formatted: formatL1AsSearchContext(l1),
  };
}

// ---------------------------------------------------------------------------
// Tool: memory_store
// ---------------------------------------------------------------------------

export type MemoryStoreInput = {
  name: string;
  type: string;
  summary?: string;
  confidence?: number;
  /** Optional relations to create: [{target, relation}] */
  relations?: Array<{ targetName: string; targetType: string; relation: string }>;
};

export type MemoryStoreOutput = {
  entityId: string;
  name: string;
  isNew: boolean;
  edgesCreated: number;
};

export function memoryStore(
  engine: MemoryGraphEngine,
  input: MemoryStoreInput,
): MemoryStoreOutput {
  const entity = engine.upsertEntity({
    name: input.name,
    type: input.type,
    summary: input.summary,
    confidence: input.confidence,
    source: "manual",
  });

  let edgesCreated = 0;
  if (input.relations) {
    for (const rel of input.relations) {
      // Ensure target entity exists
      const target = engine.upsertEntity({
        name: rel.targetName,
        type: rel.targetType,
        source: "manual",
      });
      engine.addEdge({
        fromId: entity.id,
        toId: target.id,
        relation: rel.relation,
      });
      edgesCreated++;
    }
  }

  return {
    entityId: entity.id,
    name: entity.name,
    isNew: entity.isNew,
    edgesCreated,
  };
}

// ---------------------------------------------------------------------------
// Tool: memory_detail
// ---------------------------------------------------------------------------

export type MemoryDetailInput = {
  /** Entity name or ID */
  entity: string;
  /** Entity type (helps disambiguate when searching by name) */
  type?: string;
  /** Detail level: "full" (default), "summary" (no episodes/history), "minimal" (name+summary only) */
  detailLevel?: L2DetailLevel;
};

export type MemoryDetailOutput = {
  found: boolean;
  formatted: string;
  entityId?: string;
};

export function memoryDetail(
  engine: MemoryGraphEngine,
  input: MemoryDetailInput,
): MemoryDetailOutput {
  // Try as ID first
  let entity = engine.getEntity(input.entity);

  // Fall back to name search
  if (!entity) {
    const matches = engine.findEntities({
      name: input.entity,
      type: input.type as EntityInput["type"],
      activeOnly: true,
      limit: 1,
    });
    entity = matches[0] ?? null;
  }

  if (!entity) {
    return { found: false, formatted: `No entity found matching "${input.entity}"` };
  }

  // Touch entity to track access frequency
  engine.touchEntity(entity.id);

  const l2 = buildL2Context(engine, entity.id, { detailLevel: input.detailLevel });
  if (!l2) {
    return { found: false, formatted: `Entity data unavailable for "${input.entity}"` };
  }

  return {
    found: true,
    formatted: formatL2AsDetail(l2),
    entityId: entity.id,
  };
}

// ---------------------------------------------------------------------------
// Tool: memory_graph (visualize relationships)
// ---------------------------------------------------------------------------

export type MemoryGraphInput = {
  /** Center entity name or ID */
  entity: string;
  /** BFS depth. Default 1. */
  depth?: number;
};

export type MemoryGraphOutput = {
  found: boolean;
  entities: Array<{ name: string; type: string; isCenterEntity: boolean }>;
  edges: Array<{ from: string; to: string; relation: string }>;
  formatted: string;
};

export function memoryGraph(
  engine: MemoryGraphEngine,
  input: MemoryGraphInput,
): MemoryGraphOutput {
  // Resolve entity
  let entity = engine.getEntity(input.entity);
  if (!entity) {
    const matches = engine.findEntities({ name: input.entity, activeOnly: true, limit: 1 });
    entity = matches[0] ?? null;
  }

  if (!entity) {
    return {
      found: false,
      entities: [],
      edges: [],
      formatted: `No entity found matching "${input.entity}"`,
    };
  }

  const depth = input.depth ?? 1;
  const neighbors = engine.getNeighbors(entity.id, depth);

  const entities = neighbors.entities.map((e) => ({
    name: e.name,
    type: e.type,
    isCenterEntity: e.id === entity!.id,
  }));

  const entityIdToName = new Map(neighbors.entities.map((e) => [e.id, e.name]));

  const edges = neighbors.edges.map((e) => ({
    from: entityIdToName.get(e.from_id) ?? e.from_id.slice(0, 8),
    to: entityIdToName.get(e.to_id) ?? e.to_id.slice(0, 8),
    relation: e.relation,
  }));

  // ASCII graph visualization
  const lines: string[] = [`## Graph: ${entity.name} (depth=${depth})`];
  lines.push(`Entities: ${entities.length} | Edges: ${edges.length}\n`);

  for (const e of edges) {
    lines.push(`  ${e.from} --[${e.relation}]--> ${e.to}`);
  }

  if (edges.length === 0) {
    lines.push("  (no connections)");
  }

  return {
    found: true,
    entities,
    edges,
    formatted: lines.join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Tool: memory_invalidate
// ---------------------------------------------------------------------------

export type MemoryInvalidateInput = {
  /** Entity name or ID */
  entity: string;
  type?: string;
  reason?: string;
};

export type MemoryInvalidateOutput = {
  invalidated: boolean;
  entityId?: string;
  reason?: string;
};

export function memoryInvalidate(
  engine: MemoryGraphEngine,
  input: MemoryInvalidateInput,
): MemoryInvalidateOutput {
  let entity = engine.getEntity(input.entity);
  if (!entity) {
    const matches = engine.findEntities({
      name: input.entity,
      type: input.type as EntityInput["type"],
      activeOnly: true,
      limit: 1,
    });
    entity = matches[0] ?? null;
  }

  if (!entity) {
    return { invalidated: false, reason: `No active entity found matching "${input.entity}"` };
  }

  engine.invalidateEntity(entity.id, input.reason);
  return {
    invalidated: true,
    entityId: entity.id,
    reason: input.reason ?? "manually invalidated",
  };
}

// ---------------------------------------------------------------------------
// Tool: memory_consolidate
// ---------------------------------------------------------------------------

export type MemoryConsolidateInput = {
  dryRun?: boolean;
};

export type MemoryConsolidateOutput = ConsolidationResult;

export function memoryConsolidate(
  engine: MemoryGraphEngine,
  input: MemoryConsolidateInput,
): MemoryConsolidateOutput {
  return consolidateGraph(engine, { dryRun: input.dryRun });
}
