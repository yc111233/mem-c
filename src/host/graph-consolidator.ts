/**
 * Graph consolidation: merge duplicates, decay stale entities, prune orphans.
 *
 * Designed to run periodically (e.g. every 24h) to maintain graph hygiene.
 * All mutations run inside a single transaction.
 */

import type { MemoryGraphEngine, Entity } from "./graph-engine.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConsolidationResult = {
  merged: number;
  decayed: number;
  pruned: number;
  errors: string[];
};

export type ConsolidationOpts = {
  /** Entities not accessed/updated for this many days get decayed. Default 30. */
  decayAfterDays?: number;
  /** Orphan entities below this confidence threshold get pruned. Default 0.3. */
  pruneThreshold?: number;
  /** Enable same-name entity merge. Default true. */
  enableMerge?: boolean;
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

  const result: ConsolidationResult = { merged: 0, decayed: 0, pruned: 0, errors: [] };

  const run = () => {
    // Phase 1: Scan
    const entities = engine.getActiveEntities();

    // Phase 2: Merge — same-name entities with different types
    if (enableMerge) {
      const byName = new Map<string, Entity[]>();
      for (const e of entities) {
        const group = byName.get(e.name) ?? [];
        group.push(e);
        byName.set(e.name, group);
      }

      for (const [, group] of byName) {
        if (group.length < 2) continue;
        // Keep the entity with highest confidence (tie-break: most recent updated_at)
        group.sort((a, b) => b.confidence - a.confidence || b.updated_at - a.updated_at);
        const keeper = group[0]!;
        for (let i = 1; i < group.length; i++) {
          const dup = group[i]!;
          try {
            if (!dryRun) {
              // ORDER MATTERS: reassign edges BEFORE invalidate.
              // invalidateEntity sets valid_until on all edges touching dup.id.
              // If we invalidate first, the edges are gone before we can redirect them.
              engine.reassignEdges(dup.id, keeper.id);
              engine.invalidateEntity(dup.id, `merged into ${keeper.id} (${keeper.type})`);
            }
            result.merged++;
          } catch (err) {
            result.errors.push(
              `merge ${dup.name}(${dup.type}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
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
