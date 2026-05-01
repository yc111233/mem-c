/**
 * Graph consolidation: merge duplicates, decay stale entities, prune orphans.
 *
 * Designed to run periodically (e.g. every 24h) to maintain graph hygiene.
 * All mutations run inside a single transaction.
 */

import { type MemoryGraphEngine, type Entity } from "./graph-engine.js";
import {
  linkEntities,
  findLinkCandidates,
  type LinkerOpts,
} from "./graph-linking.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConsolidationResult = {
  merged: number;
  linked: number;
  decayed: number;
  pruned: number;
  errors: string[];
};

export type ConsolidationOpts = {
  /** Entities not accessed/updated for this many days get decayed. Default 30. */
  decayAfterDays?: number;
  /** Orphan entities below this confidence threshold get pruned. Default 0.3. */
  pruneThreshold?: number;
  /** Enable entity linking (replaces old same-name merge). Default true. */
  enableMerge?: boolean;
  /** Linker thresholds. */
  linkerOpts?: LinkerOpts;
  /** Dry run — report what would happen without modifying. Default false. */
  dryRun?: boolean;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function consolidateGraph(
  engine: MemoryGraphEngine,
  opts?: ConsolidationOpts,
): ConsolidationResult {
  const decayAfterDays = opts?.decayAfterDays ?? 30;
  const pruneThreshold = opts?.pruneThreshold ?? 0.3;
  const enableMerge = opts?.enableMerge ?? true;
  const dryRun = opts?.dryRun ?? false;
  const now = Date.now();
  const decayCutoff = now - decayAfterDays * 86_400_000;

  const result: ConsolidationResult = { merged: 0, linked: 0, decayed: 0, pruned: 0, errors: [] };

  const run = () => {
    // Phase 1: Scan
    const entities = engine.getActiveEntities();

    // Phase 2: Entity linking — score-based replacement for brute-force merge
    if (enableMerge) {
      const candidates = findLinkCandidates(engine);
      for (const candidate of candidates) {
        try {
          const linkResult = linkEntities(engine, candidate, opts?.linkerOpts);

          if (linkResult.decision === "same_as") {
            // Merge: keep the entity with higher confidence
            const { entityA, entityB } = candidate;
            const [keeper, loser] =
              entityA.confidence >= entityB.confidence
                ? [entityA, entityB]
                : [entityB, entityA];

            if (!dryRun) {
              engine.reassignEdges(loser.id, keeper.id);
              engine.addAlias(keeper.id, loser.name);
              engine.invalidateEntity(
                loser.id,
                `linked as same_as -> ${keeper.id} (score: ${linkResult.score.toFixed(2)}, evidence: ${linkResult.evidence.join("; ")})`,
              );
            }
            result.merged++;
          } else if (linkResult.decision === "possibly_same_as") {
            // Log but don't merge
            result.linked++;
          }
          // "alias_of" and "distinct" — skip silently
        } catch (err) {
          result.errors.push(
            `link ${candidate.entityA.name} <-> ${candidate.entityB.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // Phase 3: Decay — reduce confidence of stale entities
    // Re-fetch since merge may have invalidated some
    const activeAfterMerge = dryRun ? entities : engine.getActiveEntities();
    for (const e of activeAfterMerge) {
      // Skip entities modified during this consolidation run (e.g., merge keepers)
      if (e.updated_at >= now - 1000) continue; // within last second

      const lastActivity = Math.max(e.updated_at, e.last_accessed_at);
      if (lastActivity >= decayCutoff) continue;

      const factor = e.last_accessed_at > 0 ? 0.9 : 0.8;
      const newConfidence = e.confidence * factor;
      if (newConfidence >= e.confidence) continue; // already at floor

      try {
        if (!dryRun) {
          engine.updateConfidence(e.id, newConfidence);
        }
        result.decayed++;
      } catch (err) {
        result.errors.push(
          `decay ${e.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Phase 4: Prune — invalidate low-confidence orphans (no edges)
    const activeAfterDecay = dryRun ? activeAfterMerge : engine.getActiveEntities();
    const db = engine.getDb();
    // Build set of entities that have at least one active edge
    const connectedIds = new Set<string>();
    const edgeRows = db
      .prepare(`SELECT DISTINCT from_id, to_id FROM edges WHERE valid_until IS NULL`)
      .all() as Array<{ from_id: string; to_id: string }>;
    for (const row of edgeRows) {
      connectedIds.add(row.from_id);
      connectedIds.add(row.to_id);
    }

    for (const e of activeAfterDecay) {
      if (e.confidence >= pruneThreshold) continue;
      if (connectedIds.has(e.id)) continue; // has edges, keep

      try {
        if (!dryRun) {
          engine.invalidateEntity(e.id, "auto-pruned: low confidence orphan");
        }
        result.pruned++;
      } catch (err) {
        result.errors.push(
          `prune ${e.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };

  if (dryRun) {
    run();
  } else {
    engine.runInTransaction(run);
  }

  return result;
}
