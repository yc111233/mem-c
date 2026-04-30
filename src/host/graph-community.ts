/**
 * Community detection using BFS-based connected components.
 * Finds connected subgraphs in the active entity/edge graph.
 */

import type { DatabaseSync } from "node:sqlite";
import type { MemoryGraphEngine } from "./graph-engine.js";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Community = {
  id: string;
  label: string | null;
  reportSummary: string | null;
  entityCount: number;
  entityIds: string[];
};

export type DetectionResult = {
  communities: Community[];
  totalEntities: number;
};

export type DetectionOpts = {
  /** Only consider active entities. Default true. */
  activeOnly?: boolean;
  /** Max community size to track. Default 1000. */
  maxCommunitySize?: number;
};

/**
 * Callback type for LLM community summarization.
 * Receives entity names/types/summaries and edge relations for one community.
 * Returns a concise label/summary for the community.
 */
export type SummarizeFn = (params: {
  entities: Array<{ name: string; type: string; summary: string | null }>;
  relations: Array<{ from: string; to: string; relation: string }>;
}) => Promise<{ label: string; summary: string }>;

export const COMMUNITY_SUMMARY_PROMPT = `You are analyzing a cluster of related entities in a knowledge graph. Generate TWO things:

1. A concise label (2-5 words) that describes what this community is about.
2. A summary (2-3 sentences) describing the community's theme, key entities, and relationships.

Input: a list of entities with their types and summaries, and the relationships between them.

Output format (JSON):
{"label": "...", "summary": "..."}

Rules:
- Be specific, not generic. "Frontend frameworks" is better than "Technology".
- The summary should mention key entities and how they relate.
- If there's no clear theme, use the most prominent entity name for the label.`;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect communities in the graph using BFS connected components.
 * Clears previous community data and stores fresh results.
 */
export function detectCommunities(
  engine: MemoryGraphEngine,
  opts?: DetectionOpts,
): DetectionResult {
  const activeOnly = opts?.activeOnly ?? true;
  const maxCommunitySize = opts?.maxCommunitySize ?? 1000;
  const db = engine.getDb();
  const ns = engine.getNamespace();

  // Build adjacency list from active edges
  const adjacency = new Map<string, Set<string>>();

  // Load entities (engine methods already namespace-scoped)
  const entities = activeOnly
    ? engine.getActiveEntities()
    : engine.findEntities({ activeOnly: false, limit: 10_000 });

  for (const e of entities) {
    adjacency.set(e.id, new Set());
  }

  // Load edges (raw SQL, must scope by namespace manually)
  const edgeRows = ns !== null
    ? db.prepare(`SELECT from_id, to_id FROM edges WHERE valid_until IS NULL AND namespace = ?`).all(ns) as Array<{ from_id: string; to_id: string }>
    : db.prepare(`SELECT from_id, to_id FROM edges WHERE valid_until IS NULL AND namespace IS NULL`).all() as Array<{ from_id: string; to_id: string }>;

  for (const edge of edgeRows) {
    if (adjacency.has(edge.from_id) && adjacency.has(edge.to_id)) {
      adjacency.get(edge.from_id)!.add(edge.to_id);
      adjacency.get(edge.to_id)!.add(edge.from_id);
    }
  }

  // BFS connected components
  const visited = new Set<string>();
  const communities: Community[] = [];

  for (const entityId of adjacency.keys()) {
    if (visited.has(entityId)) continue;

    // BFS from this entity — complete full traversal to avoid losing nodes
    const component: string[] = [];
    const queue = [entityId];
    visited.add(entityId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      // Only add to component if under limit, but always process neighbors
      if (component.length < maxCommunitySize) {
        component.push(current);
      }

      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    if (component.length > 0) {
      communities.push({
        id: randomUUID(),
        label: null,
        reportSummary: null,
        entityCount: component.length,
        entityIds: component,
      });
    }
  }

  // Sort by size descending
  communities.sort((a, b) => b.entityCount - a.entityCount);

  // Store results
  storeCommunities(db, communities, ns);

  return { communities, totalEntities: entities.length };
}

// ---------------------------------------------------------------------------
// Summarization
// ---------------------------------------------------------------------------

/**
 * Run an LLM summarize function on each community to generate labels and reports.
 * Stores results in the communities table.
 */
export async function summarizeCommunities(
  engine: MemoryGraphEngine,
  summarizeFn: SummarizeFn,
): Promise<{ summarized: number; errors: string[] }> {
  const ns = engine.getNamespace();
  const communities = getCommunities(engine, ns);
  const db = engine.getDb();
  const updateLabel = db.prepare(`UPDATE communities SET label = ?, report_summary = ?, updated_at = ? WHERE id = ?`);
  const now = Date.now();

  let summarized = 0;
  const errors: string[] = [];

  for (const community of communities) {
    try {
      const entities = community.entityIds
        .map((id) => engine.getEntity(id))
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .map((e) => ({ name: e.name, type: e.type, summary: e.summary }));

      const memberSet = new Set(community.entityIds);
      const relations: Array<{ from: string; to: string; relation: string }> = [];
      const seenEdges = new Set<string>();

      for (const entityId of community.entityIds) {
        const edges = engine.findEdges({ entityId, activeOnly: true, limit: 50 });
        for (const edge of edges) {
          if (memberSet.has(edge.from_id) && memberSet.has(edge.to_id) && !seenEdges.has(edge.id)) {
            seenEdges.add(edge.id);
            const fromEntity = engine.getEntity(edge.from_id);
            const toEntity = engine.getEntity(edge.to_id);
            relations.push({
              from: fromEntity?.name ?? edge.from_id.slice(0, 8),
              to: toEntity?.name ?? edge.to_id.slice(0, 8),
              relation: edge.relation,
            });
          }
        }
      }

      const result = await summarizeFn({ entities, relations });
      updateLabel.run(result.label, result.summary, now, community.id);
      summarized++;
    } catch (err) {
      errors.push(
        `community ${community.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { summarized, errors };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function storeCommunities(db: DatabaseSync, communities: Community[], namespace: string | null): void {
  const now = Date.now();

  // Clear old data for this namespace only (ON DELETE CASCADE handles members)
  if (namespace !== null) {
    db.prepare(`DELETE FROM communities WHERE namespace = ?`).run(namespace);
  } else {
    db.prepare(`DELETE FROM communities WHERE namespace IS NULL`).run();
  }

  const insertCommunity = db.prepare(
    `INSERT INTO communities (id, label, report_summary, entity_count, created_at, updated_at, namespace) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMember = db.prepare(
    `INSERT INTO community_members (community_id, entity_id) VALUES (?, ?)`,
  );

  for (const community of communities) {
    insertCommunity.run(community.id, community.label, community.reportSummary, community.entityCount, now, now, namespace);
    for (const entityId of community.entityIds) {
      insertMember.run(community.id, entityId);
    }
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Get all stored communities, sorted by entity count descending.
 */
export function getCommunities(engine: MemoryGraphEngine, namespace?: string | null): Community[] {
  const db = engine.getDb();
  const ns = namespace ?? engine.getNamespace();
  const rows = ns !== null
    ? db.prepare(`SELECT id, label, report_summary, entity_count FROM communities WHERE namespace = ? ORDER BY entity_count DESC`).all(ns) as Array<{ id: string; label: string | null; report_summary: string | null; entity_count: number }>
    : db.prepare(`SELECT id, label, report_summary, entity_count FROM communities WHERE namespace IS NULL ORDER BY entity_count DESC`).all() as Array<{ id: string; label: string | null; report_summary: string | null; entity_count: number }>;

  return rows.map((row) => {
    const members = db
      .prepare(`SELECT entity_id FROM community_members WHERE community_id = ?`)
      .all(row.id) as Array<{ entity_id: string }>;
    return {
      id: row.id,
      label: row.label,
      reportSummary: row.report_summary,
      entityCount: row.entity_count,
      entityIds: members.map((m) => m.entity_id),
    };
  });
}

/**
 * Get the community containing a specific entity.
 * Returns null if entity is not in any community.
 */
export function getCommunityForEntity(
  engine: MemoryGraphEngine,
  entityId: string,
): Community | null {
  const db = engine.getDb();
  const ns = engine.getNamespace();
  const row = ns !== null
    ? db.prepare(
        `SELECT c.id, c.label, c.report_summary, c.entity_count FROM communities c ` +
          `JOIN community_members cm ON cm.community_id = c.id ` +
          `WHERE cm.entity_id = ? AND c.namespace = ? LIMIT 1`,
      ).get(entityId, ns) as { id: string; label: string | null; report_summary: string | null; entity_count: number } | undefined
    : db.prepare(
        `SELECT c.id, c.label, c.report_summary, c.entity_count FROM communities c ` +
          `JOIN community_members cm ON cm.community_id = c.id ` +
          `WHERE cm.entity_id = ? AND c.namespace IS NULL LIMIT 1`,
      ).get(entityId) as { id: string; label: string | null; report_summary: string | null; entity_count: number } | undefined;

  if (!row) return null;

  const members = db
    .prepare(`SELECT entity_id FROM community_members WHERE community_id = ?`)
    .all(row.id) as Array<{ entity_id: string }>;

  return {
    id: row.id,
    label: row.label,
    reportSummary: row.report_summary,
    entityCount: row.entity_count,
    entityIds: members.map((m) => m.entity_id),
  };
}

// ---------------------------------------------------------------------------
// Report retrieval (for global search)
// ---------------------------------------------------------------------------

/**
 * Get a single community report by ID.
 * Returns null if not found or has no summary.
 */
export function getCommunityReport(
  engine: MemoryGraphEngine,
  communityId: string,
): { label: string; summary: string; entityCount: number } | null {
  const db = engine.getDb();
  const ns = engine.getNamespace();
  const row = ns !== null
    ? db.prepare(
        `SELECT label, report_summary, entity_count FROM communities WHERE id = ? AND namespace = ?`,
      ).get(communityId, ns) as { label: string | null; report_summary: string | null; entity_count: number } | undefined
    : db.prepare(
        `SELECT label, report_summary, entity_count FROM communities WHERE id = ? AND namespace IS NULL`,
      ).get(communityId) as { label: string | null; report_summary: string | null; entity_count: number } | undefined;

  if (!row || !row.label || !row.report_summary) return null;

  return {
    label: row.label,
    summary: row.report_summary,
    entityCount: row.entity_count,
  };
}

/**
 * Get all community reports with summaries, sorted by entity count descending.
 * Only returns communities that have been summarized.
 */
export function getGlobalCommunityReports(
  engine: MemoryGraphEngine,
): Array<{ id: string; label: string; summary: string; entityCount: number }> {
  const db = engine.getDb();
  const ns = engine.getNamespace();
  const rows = ns !== null
    ? db.prepare(
        `SELECT id, label, report_summary, entity_count FROM communities WHERE namespace = ? AND label IS NOT NULL AND report_summary IS NOT NULL ORDER BY entity_count DESC`,
      ).all(ns) as Array<{ id: string; label: string; report_summary: string; entity_count: number }>
    : db.prepare(
        `SELECT id, label, report_summary, entity_count FROM communities WHERE namespace IS NULL AND label IS NOT NULL AND report_summary IS NOT NULL ORDER BY entity_count DESC`,
      ).all() as Array<{ id: string; label: string; report_summary: string; entity_count: number }>;

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    summary: row.report_summary,
    entityCount: row.entity_count,
  }));
}
