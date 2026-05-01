/**
 * Observability collector for MEM-C.
 *
 * Tracks write correctness, retrieval quality, context efficiency,
 * and index health metrics. Zero external dependencies — pure in-memory
 * counters that read live graph state on snapshot.
 */

import type { MemoryGraphEngine } from "./graph-engine.js";

// ---------------------------------------------------------------------------
// Metric types
// ---------------------------------------------------------------------------

export type MemcMetrics = {
  /** Write correctness */
  write: {
    assertionsCreated: number;
    proposalsCreated: number;
    proposalsApproved: number;
    proposalsRejected: number;
    destructiveApplyBlocked: number;
  };
  /** Retrieval quality */
  retrieval: {
    totalSearches: number;
    entityModeSearches: number;
    globalModeSearches: number;
    mixedModeSearches: number;
    avgResultsReturned: number;
    cacheHitRate: number;
  };
  /** Context efficiency */
  context: {
    avgPackedTokens: number;
    avgEvidenceDensity: number;
    budgetOvershootCount: number;
    pinnedMemoryTokens: number;
  };
  /** Index health */
  index: {
    totalEntities: number;
    activeEntities: number;
    totalEdges: number;
    totalCommunities: number;
    pendingProposals: number;
    lastConsolidationAt: number | null;
  };
};

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export class ObservabilityCollector {
  private metrics: MemcMetrics;
  private searchCount = 0;
  private searchResultCounts: number[] = [];
  private packedTokenCounts: number[] = [];
  private evidenceDensitySums: number[] = [];
  private cacheHits = 0;
  private cacheMisses = 0;
  private overshootCount = 0;
  private lastConsolidationAt: number | null = null;

  constructor() {
    this.metrics = this.createEmpty();
  }

  private createEmpty(): MemcMetrics {
    return {
      write: {
        assertionsCreated: 0,
        proposalsCreated: 0,
        proposalsApproved: 0,
        proposalsRejected: 0,
        destructiveApplyBlocked: 0,
      },
      retrieval: {
        totalSearches: 0,
        entityModeSearches: 0,
        globalModeSearches: 0,
        mixedModeSearches: 0,
        avgResultsReturned: 0,
        cacheHitRate: 0,
      },
      context: {
        avgPackedTokens: 0,
        avgEvidenceDensity: 0,
        budgetOvershootCount: 0,
        pinnedMemoryTokens: 0,
      },
      index: {
        totalEntities: 0,
        activeEntities: 0,
        totalEdges: 0,
        totalCommunities: 0,
        pendingProposals: 0,
        lastConsolidationAt: null,
      },
    };
  }

  // -- Recording methods ----------------------------------------------------

  /** Record a search event with its mode, result count, and cache status. */
  recordSearch(mode: string, resultCount: number, cached: boolean): void {
    this.searchCount++;
    this.searchResultCounts.push(resultCount);
    if (cached) this.cacheHits++;
    else this.cacheMisses++;

    if (mode === "entity") this.metrics.retrieval.entityModeSearches++;
    else if (mode === "global") this.metrics.retrieval.globalModeSearches++;
    else this.metrics.retrieval.mixedModeSearches++;
  }

  /** Record a context packing event. */
  recordContextPacked(tokens: number, budget: number, density?: number): void {
    this.packedTokenCounts.push(tokens);
    if (tokens > budget) this.overshootCount++;
    if (density !== undefined) this.evidenceDensitySums.push(density);
  }

  /** Record a write event. */
  recordWrite(
    type: "assertion" | "proposal_created" | "proposal_approved" | "proposal_rejected" | "blocked",
  ): void {
    switch (type) {
      case "assertion":
        this.metrics.write.assertionsCreated++;
        break;
      case "proposal_created":
        this.metrics.write.proposalsCreated++;
        break;
      case "proposal_approved":
        this.metrics.write.proposalsApproved++;
        break;
      case "proposal_rejected":
        this.metrics.write.proposalsRejected++;
        break;
      case "blocked":
        this.metrics.write.destructiveApplyBlocked++;
        break;
    }
  }

  /** Record pinned memory token count. */
  recordPinnedMemory(tokens: number): void {
    this.metrics.context.pinnedMemoryTokens = tokens;
  }

  /** Record a consolidation run. */
  recordConsolidation(): void {
    this.lastConsolidationAt = Date.now();
  }

  // -- Snapshot -------------------------------------------------------------

  /** Take a point-in-time snapshot combining live index stats with recorded counters. */
  getSnapshot(engine: MemoryGraphEngine): MemcMetrics {
    const stats = engine.stats();
    const db = engine.getDb();

    let pendingProposals = 0;
    try {
      pendingProposals = (
        db.prepare(`SELECT COUNT(*) as c FROM supersession_proposals WHERE status = 'pending'`).get() as {
          c: number;
        }
      ).c;
    } catch {
      // table may not exist in edge cases
    }

    let communityCount = 0;
    try {
      communityCount = (db.prepare(`SELECT COUNT(*) as c FROM communities`).get() as { c: number }).c;
    } catch {
      // table may not exist
    }

    return {
      ...this.metrics,
      retrieval: {
        ...this.metrics.retrieval,
        totalSearches: this.searchCount,
        avgResultsReturned:
          this.searchResultCounts.length > 0
            ? this.searchResultCounts.reduce((a, b) => a + b, 0) / this.searchResultCounts.length
            : 0,
        cacheHitRate:
          this.cacheHits + this.cacheMisses > 0
            ? this.cacheHits / (this.cacheHits + this.cacheMisses)
            : 0,
      },
      context: {
        ...this.metrics.context,
        avgPackedTokens:
          this.packedTokenCounts.length > 0
            ? this.packedTokenCounts.reduce((a, b) => a + b, 0) / this.packedTokenCounts.length
            : 0,
        avgEvidenceDensity:
          this.evidenceDensitySums.length > 0
            ? this.evidenceDensitySums.reduce((a, b) => a + b, 0) / this.evidenceDensitySums.length
            : 0,
        budgetOvershootCount: this.overshootCount,
      },
      index: {
        totalEntities: stats.entities,
        activeEntities: stats.activeEntities,
        totalEdges: stats.edges,
        totalCommunities: communityCount,
        pendingProposals,
        lastConsolidationAt: this.lastConsolidationAt,
      },
    };
  }

  // -- Reset ----------------------------------------------------------------

  /** Reset all recorded counters (does not touch live graph data). */
  reset(): void {
    this.metrics = this.createEmpty();
    this.searchCount = 0;
    this.searchResultCounts = [];
    this.packedTokenCounts = [];
    this.evidenceDensitySums = [];
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.overshootCount = 0;
    this.lastConsolidationAt = null;
  }
}
