import type { DatabaseSync } from "node:sqlite";
import type { Entity, Edge, MemoryGraphEngine } from "./graph-engine.js";
import { searchGraph, type GraphSearchResult } from "./graph-search.js";

// ---------------------------------------------------------------------------
// Context tiers
// ---------------------------------------------------------------------------

/**
 * L0: Lightweight entity roster injected into every system prompt.
 * Lists active entity names and types. Minimal token cost (~200 tokens).
 */
export type L0Context = {
  tier: "L0";
  /** One line per entity: "name (type)" */
  entries: string[];
  /** Estimated token count. */
  estimatedTokens: number;
};

/**
 * L1: Search-triggered context with entity summaries and key relationships.
 * Returned alongside memory search results (~800 tokens).
 */
export type L1Context = {
  tier: "L1";
  results: Array<{
    name: string;
    type: string;
    summary: string;
    relations: string[];
    score: number;
  }>;
  estimatedTokens: number;
};

/**
 * L2: Full detail context for a specific entity.
 * Includes complete entity data, all edges, and related episodes (~2000 tokens).
 */
export type L2Context = {
  tier: "L2";
  entity: {
    id: string;
    name: string;
    type: string;
    summary: string | null;
    confidence: number;
    source: string;
    validFrom: number;
    history: Array<{ summary: string | null; validFrom: number; validUntil: number | null }>;
  };
  edges: Array<{
    direction: "outgoing" | "incoming";
    relation: string;
    targetName: string;
    targetType: string;
    weight: number;
  }>;
  episodes: Array<{
    content: string;
    timestamp: number;
    sessionKey: string;
  }>;
  estimatedTokens: number;
};

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// L0: Entity roster for system prompt
// ---------------------------------------------------------------------------

export function buildL0Context(
  engine: MemoryGraphEngine,
  opts?: { maxEntities?: number; maxTokens?: number },
): L0Context {
  const maxEntities = opts?.maxEntities ?? 50;
  const maxTokens = opts?.maxTokens ?? 200;
  const entities = engine.getActiveEntities();

  // Sort by updated_at DESC to prioritize recently-touched entities
  const sorted = [...entities].sort((a, b) => b.updated_at - a.updated_at);

  const entries: string[] = [];
  let totalTokens = 0;
  const headerTokens = estimateTokens("Known entities:\n");
  totalTokens += headerTokens;

  for (const entity of sorted) {
    if (entries.length >= maxEntities) break;
    const line = `- ${entity.name} (${entity.type})`;
    const lineTokens = estimateTokens(line + "\n");
    if (totalTokens + lineTokens > maxTokens) break;
    entries.push(line);
    totalTokens += lineTokens;
  }

  return { tier: "L0", entries, estimatedTokens: totalTokens };
}

/**
 * Format L0 context as a prompt section string.
 * Returns empty string if no entities exist.
 */
export function formatL0AsPromptSection(l0: L0Context): string {
  if (l0.entries.length === 0) return "";
  return `## Known Entities\n${l0.entries.join("\n")}`;
}

// ---------------------------------------------------------------------------
// L1: Search-triggered context
// ---------------------------------------------------------------------------

export function buildL1Context(
  db: DatabaseSync,
  engine: MemoryGraphEngine,
  query: string,
  opts?: {
    maxResults?: number;
    maxTokens?: number;
    queryEmbedding?: number[];
  },
): L1Context {
  const maxResults = opts?.maxResults ?? 6;
  const maxTokens = opts?.maxTokens ?? 800;

  const searchResults = searchGraph(db, engine, query, {
    maxResults: maxResults * 2, // over-fetch for token budget trimming
    includeEdges: true,
    queryEmbedding: opts?.queryEmbedding,
  });

  const results: L1Context["results"] = [];
  let totalTokens = 0;

  for (const hit of searchResults) {
    if (results.length >= maxResults) break;

    const relations = hit.edges.slice(0, 5).map((edge) => {
      const isOutgoing = edge.from_id === hit.entity.id;
      const targetId = isOutgoing ? edge.to_id : edge.from_id;
      const targetName = hit.relatedNames.find((_, i) => {
        // Best effort name lookup from relatedNames
        return true;
      }) ?? targetId.slice(0, 8);
      const arrow = isOutgoing ? "->" : "<-";
      return `${arrow} ${edge.relation} ${hit.relatedNames[0] ?? ""}`;
    });

    const entry = {
      name: hit.entity.name,
      type: hit.entity.type,
      summary: hit.entity.summary ?? "",
      relations,
      score: hit.score,
    };

    const entryText = formatL1Entry(entry);
    const entryTokens = estimateTokens(entryText);
    if (totalTokens + entryTokens > maxTokens) break;

    results.push(entry);
    totalTokens += entryTokens;
  }

  return { tier: "L1", results, estimatedTokens: totalTokens };
}

function formatL1Entry(entry: L1Context["results"][number]): string {
  const lines = [`**${entry.name}** (${entry.type})`];
  if (entry.summary) {
    lines.push(entry.summary);
  }
  if (entry.relations.length > 0) {
    lines.push(`Relations: ${entry.relations.join(", ")}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Format L1 context as a string suitable for tool result injection.
 */
export function formatL1AsSearchContext(l1: L1Context): string {
  if (l1.results.length === 0) return "";
  const sections = l1.results.map(formatL1Entry);
  return `## Related Knowledge\n${sections.join("\n")}`;
}

// ---------------------------------------------------------------------------
// L2: Full entity detail (on-demand)
// ---------------------------------------------------------------------------

export function buildL2Context(
  engine: MemoryGraphEngine,
  entityId: string,
  opts?: { maxEpisodes?: number; maxTokens?: number },
): L2Context | null {
  const maxEpisodes = opts?.maxEpisodes ?? 10;
  const entity = engine.getEntity(entityId);
  if (!entity) return null;

  // History
  const history = engine.getEntityHistory(entity.name).map((v) => ({
    summary: v.entity.summary,
    validFrom: v.entity.valid_from,
    validUntil: v.entity.valid_until,
  }));

  // Edges with resolved target names
  const allEdges = engine.findEdges({ entityId, activeOnly: true, limit: 30 });
  const edges = allEdges.map((edge) => {
    const isOutgoing = edge.from_id === entityId;
    const targetEntityId = isOutgoing ? edge.to_id : edge.from_id;
    const target = engine.getEntity(targetEntityId);
    return {
      direction: (isOutgoing ? "outgoing" : "incoming") as "outgoing" | "incoming",
      relation: edge.relation,
      targetName: target?.name ?? targetEntityId.slice(0, 8),
      targetType: target?.type ?? "unknown",
      weight: edge.weight,
    };
  });

  // Episodes that extracted this entity
  // Query episodes that reference this entity ID
  const episodes = findEpisodesForEntity(engine, entityId, maxEpisodes);

  const entitySection = {
    id: entity.id,
    name: entity.name,
    type: entity.type,
    summary: entity.summary,
    confidence: entity.confidence,
    source: entity.source,
    validFrom: entity.valid_from,
    history,
  };

  // Estimate tokens
  const formatted = formatL2AsDetail({ tier: "L2", entity: entitySection, edges, episodes, estimatedTokens: 0 });
  const estimatedTokens = estimateTokens(formatted);

  return { tier: "L2", entity: entitySection, edges, episodes, estimatedTokens };
}

function findEpisodesForEntity(
  engine: MemoryGraphEngine,
  entityId: string,
  limit: number,
): L2Context["episodes"] {
  // Episodes store extracted_entity_ids as JSON array
  // We need to search across all sessions
  // For now, use a simple approach: get recent episodes and filter
  // In the future this could use a dedicated index
  const db = engine.getDb();
  if (!db) return [];

  try {
    const rows = db
      .prepare(
        `SELECT content, timestamp, session_key FROM episodes ` +
          `WHERE extracted_entity_ids LIKE ? ` +
          `ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(`%${entityId}%`, limit) as Array<{
      content: string;
      timestamp: number;
      session_key: string;
    }>;

    return rows.map((r) => ({
      content: r.content,
      timestamp: r.timestamp,
      sessionKey: r.session_key,
    }));
  } catch {
    return [];
  }
}

/**
 * Format L2 context as a detailed view string.
 */
export function formatL2AsDetail(l2: L2Context): string {
  const lines: string[] = [];
  lines.push(`## Entity: ${l2.entity.name}`);
  lines.push(`Type: ${l2.entity.type} | Confidence: ${l2.entity.confidence} | Source: ${l2.entity.source}`);
  if (l2.entity.summary) {
    lines.push(`Summary: ${l2.entity.summary}`);
  }

  if (l2.edges.length > 0) {
    lines.push(`\n### Relationships`);
    for (const edge of l2.edges) {
      const arrow = edge.direction === "outgoing" ? "->" : "<-";
      lines.push(`- ${arrow} ${edge.relation} **${edge.targetName}** (${edge.targetType})`);
    }
  }

  if (l2.entity.history.length > 1) {
    lines.push(`\n### History`);
    for (const version of l2.entity.history) {
      const status = version.validUntil ? `invalidated ${new Date(version.validUntil).toISOString().slice(0, 10)}` : "current";
      lines.push(`- [${status}] ${version.summary ?? "(no summary)"}`);
    }
  }

  if (l2.episodes.length > 0) {
    lines.push(`\n### Related Conversations`);
    for (const ep of l2.episodes.slice(0, 5)) {
      const date = new Date(ep.timestamp).toISOString().slice(0, 10);
      const preview = ep.content.length > 120 ? ep.content.slice(0, 120) + "..." : ep.content;
      lines.push(`- [${date}] ${preview}`);
    }
  }

  return lines.join("\n");
}
