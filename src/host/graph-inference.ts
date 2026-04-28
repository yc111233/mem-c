/**
 * Relation type inference: suggest richer relation types for generic edges.
 * Uses LLM callback to analyze entity pairs and suggest more specific relations.
 */

import type { MemoryGraphEngine } from "./graph-engine.js";
import type { EdgeRow } from "./graph-schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Callback type for LLM relation inference.
 * Receives two entities and their current relation.
 * Returns a suggested relation type, confidence, and optional reason.
 */
export type InferRelationFn = (params: {
  fromName: string;
  fromType: string;
  fromSummary: string | null;
  toName: string;
  toType: string;
  toSummary: string | null;
  currentRelation: string;
}) => Promise<{ relation: string; confidence: number; reason?: string }>;

export type InferenceSuggestion = {
  edgeId: string;
  fromName: string;
  toName: string;
  currentRelation: string;
  suggestedRelation: string;
  confidence: number;
  reason?: string;
};

export type InferenceResult = {
  analyzed: number;
  suggestions: InferenceSuggestion[];
  errors: string[];
  /** Apply all suggestions to the graph (update edge relations). */
  applySuggestions: (engine: MemoryGraphEngine) => void;
};

export type InferenceOpts = {
  /** Only analyze edges with these relation types. Default: generic types. */
  targetRelations?: string[];
  /** Max edges to analyze. Default 50. */
  maxEdges?: number;
  /** Min confidence to include in suggestions. Default 0.5. */
  minConfidence?: number;
};

/** Relation types considered "generic" — candidates for inference. */
const DEFAULT_GENERIC_RELATIONS = [
  "relates_to",
  "related",
  "connects",
  "associated",
  "linked",
  "generic",
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Analyze edges with generic relation types and suggest richer alternatives.
 * Does not modify the graph — call applySuggestions() on the result to apply.
 */
export async function inferRelationTypes(
  engine: MemoryGraphEngine,
  inferFn: InferRelationFn,
  opts?: InferenceOpts,
): Promise<InferenceResult> {
  const targetRelations = opts?.targetRelations ?? DEFAULT_GENERIC_RELATIONS;
  const maxEdges = opts?.maxEdges ?? 50;
  const minConfidence = opts?.minConfidence ?? 0.5;

  const db = engine.getDb();
  const targetSet = new Set(targetRelations);

  // Find edges with generic relations
  const allEdges = db
    .prepare(
      `SELECT * FROM edges WHERE valid_until IS NULL ORDER BY created_at DESC LIMIT ?`,
    )
    .all(maxEdges * 2) as Array<EdgeRow>;

  const candidateEdges = allEdges
    .filter((e) => targetSet.has(e.relation))
    .slice(0, maxEdges);

  const suggestions: InferenceSuggestion[] = [];
  const errors: string[] = [];

  for (const edge of candidateEdges) {
    try {
      const fromEntity = engine.getEntity(edge.from_id);
      const toEntity = engine.getEntity(edge.to_id);
      if (!fromEntity || !toEntity) continue;

      const result = await inferFn({
        fromName: fromEntity.name,
        fromType: fromEntity.type,
        fromSummary: fromEntity.summary,
        toName: toEntity.name,
        toType: toEntity.type,
        toSummary: toEntity.summary,
        currentRelation: edge.relation,
      });

      if (
        result.relation !== edge.relation &&
        result.confidence >= minConfidence &&
        result.relation.trim().length > 0
      ) {
        suggestions.push({
          edgeId: edge.id,
          fromName: fromEntity.name,
          toName: toEntity.name,
          currentRelation: edge.relation,
          suggestedRelation: result.relation,
          confidence: result.confidence,
          reason: result.reason,
        });
      }
    } catch (err) {
      errors.push(
        `edge ${edge.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const applySuggestions = (engine: MemoryGraphEngine) => {
    engine.runInTransaction(() => {
      for (const suggestion of suggestions) {
        const db = engine.getDb();
        db.prepare(
          `UPDATE edges SET relation = ?, metadata = COALESCE(?, metadata) WHERE id = ?`,
        ).run(
          suggestion.suggestedRelation,
          JSON.stringify({
            inferredFrom: suggestion.currentRelation,
            confidence: suggestion.confidence,
            reason: suggestion.reason,
          }),
          suggestion.edgeId,
        );
      }
    });
  };

  return {
    analyzed: candidateEdges.length,
    suggestions,
    errors,
    applySuggestions,
  };
}
