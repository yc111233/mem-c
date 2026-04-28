/**
 * Graph visualization export: Mermaid, DOT, JSON.
 * Pure formatting — no side effects, no dependencies.
 */

import type { MemoryGraphEngine, GraphSubset, Edge } from "./graph-engine.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExportFormat = "mermaid" | "dot" | "json";

export type ExportOpts = {
  /** Output format. Default "mermaid". */
  format?: ExportFormat;
  /** Center export around this entity (with depth). Omit for full graph. */
  centerEntityId?: string;
  /** BFS depth when centerEntityId is set. Default 2. */
  depth?: number;
  /** Max entities to include. Default 100. */
  maxEntities?: number;
};

export type ExportResult = {
  content: string;
  format: ExportFormat;
  entityCount: number;
  edgeCount: number;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function exportGraph(
  engine: MemoryGraphEngine,
  opts?: ExportOpts,
): ExportResult {
  const format = opts?.format ?? "mermaid";
  const maxEntities = opts?.maxEntities ?? 100;

  let subset: GraphSubset;

  if (opts?.centerEntityId) {
    const depth = opts.depth ?? 2;
    subset = engine.getNeighbors(opts.centerEntityId, depth);
  } else {
    // Export all active entities and edges
    const entities = engine.getActiveEntities().slice(0, maxEntities);
    const entityIds = new Set(entities.map((e) => e.id));

    const allEdges: Edge[] = [];
    for (const id of entityIds) {
      const edges = engine.findEdges({ entityId: id, activeOnly: true, limit: 50 });
      for (const edge of edges) {
        if (entityIds.has(edge.from_id) && entityIds.has(edge.to_id)) {
          allEdges.push(edge);
        }
      }
    }

    // Deduplicate edges
    const seenEdges = new Set<string>();
    const uniqueEdges = allEdges.filter((e) => {
      if (seenEdges.has(e.id)) return false;
      seenEdges.add(e.id);
      return true;
    });

    subset = { entities, edges: uniqueEdges };
  }

  let content: string;
  switch (format) {
    case "mermaid":
      content = toMermaid(subset);
      break;
    case "dot":
      content = toDot(subset);
      break;
    case "json":
      content = toJson(subset);
      break;
  }

  return {
    content,
    format,
    entityCount: subset.entities.length,
    edgeCount: subset.edges.length,
  };
}

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

function toMermaid(subset: GraphSubset): string {
  const lines: string[] = ["graph LR"];

  const idMap = new Map<string, string>();
  for (let i = 0; i < subset.entities.length; i++) {
    const entity = subset.entities[i]!;
    const safeId = `n${i}`;
    idMap.set(entity.id, safeId);
    const safeName = entity.name.replace(/[\(\)\[\]\{\}"<>]/g, "_");
    const safeType = entity.type.replace(/[\(\)\[\]\{\}"<>]/g, "_");
    lines.push(`    ${safeId}["${safeName} — ${safeType}"]`);
  }

  for (const edge of subset.edges) {
    const fromId = idMap.get(edge.from_id);
    const toId = idMap.get(edge.to_id);
    if (fromId && toId) {
      const safeRelation = edge.relation.replace(/[\(\)\[\]\{\}"<>]/g, "_");
      lines.push(`    ${fromId} -->|"${safeRelation}"| ${toId}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// DOT (Graphviz)
// ---------------------------------------------------------------------------

function toDot(subset: GraphSubset): string {
  const lines: string[] = ["digraph MemoryGraph {"];

  for (const entity of subset.entities) {
    const safeName = entity.name.replace(/"/g, '\\"');
    lines.push(`  "${entity.id}" [label="${safeName} (${entity.type})"];`);
  }

  for (const edge of subset.edges) {
    const safeRelation = edge.relation.replace(/"/g, '\\"');
    lines.push(`  "${edge.from_id}" -> "${edge.to_id}" [label="${safeRelation}"];`);
  }

  lines.push("}");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

function toJson(subset: GraphSubset): string {
  const data = {
    nodes: subset.entities.map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      summary: e.summary,
      confidence: e.confidence,
    })),
    edges: subset.edges.map((e) => ({
      id: e.id,
      from: e.from_id,
      to: e.to_id,
      relation: e.relation,
      weight: e.weight,
    })),
  };
  return JSON.stringify(data, null, 2);
}
