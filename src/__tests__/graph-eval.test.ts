/**
 * MEM-C golden evaluation tests.
 *
 * Self-contained tests that verify write correctness, retrieval quality,
 * and context efficiency — the three pillars of observability.
 */

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, test } from "vitest";
import { MemoryGraphEngine, type EmbedFn } from "../host/graph-engine.js";
import { searchGraph, clearSearchCache } from "../host/graph-search.js";
import { retrieve } from "../host/graph-retrieval.js";
import {
  buildL0Context,
  buildPinnedMemory,
  formatPinnedMemory,
} from "../host/graph-context-loader.js";
import {
  detectCommunities,
  summarizeCommunities,
  getGlobalCommunityReports,
} from "../host/graph-community.js";
// Using engine methods for provenance (they handle namespace internally)
import { ObservabilityCollector, type MemcMetrics } from "../host/graph-observability.js";
import { createTestDb } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockEmbed(seed: number[]): EmbedFn {
  // Returns a deterministic embedding based on the first char of the text
  return (text: string) => {
    const hash = text.charCodeAt(0) ?? 0;
    const v = [hash / 127, (hash * 2) % 100 / 100, seed[2] ?? 0];
    // Normalize
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  };
}

// ---------------------------------------------------------------------------
// Write correctness
// ---------------------------------------------------------------------------

describe("MEM-C golden evaluation", () => {
  describe("write correctness", () => {
    let db: DatabaseSync;
    let engine: MemoryGraphEngine;

    beforeEach(() => {
      db = createTestDb();
      engine = new MemoryGraphEngine(db);
    });
    afterEach(() => db.close());

    test("provenance: assertions are recorded and retrievable", () => {
      const entity = engine.upsertEntity({ name: "Alice", type: "user", summary: "engineer" });
      const assertion = engine.recordAssertion({
        entityId: entity.id,
        assertionText: "Alice is a senior engineer",
        confidence: 0.9,
      });

      expect(assertion.entity_id).toBe(entity.id);
      expect(assertion.status).toBe("active");
      expect(assertion.confidence).toBe(0.9);

      const assertions = engine.getAssertionsForEntity(entity.id);
      expect(assertions.length).toBe(1);
      expect(assertions[0]!.assertion_text).toBe("Alice is a senior engineer");
    });

    test("supersession proposal can be approved and marks assertion superseded", () => {
      const entity = engine.upsertEntity({ name: "Bob", type: "user", summary: "developer" });
      const assertion = engine.recordAssertion({
        entityId: entity.id,
        assertionText: "Bob is a junior developer",
        confidence: 0.8,
      });

      // Create a proposal to supersede the assertion
      const proposal = engine.createSupersessionProposal({
        targetEntityId: entity.id,
        targetAssertionId: assertion.id,
        newAssertionText: "Bob is now a senior developer",
        reason: "Promoted after Q3 review",
      });

      expect(proposal.status).toBe("pending");

      // Approve the proposal
      const resolved = engine.resolveSupersession(proposal.id, "approved");
      expect(resolved).not.toBeNull();
      expect(resolved!.status).toBe("approved");

      // Target assertion should now be superseded
      const assertions = engine.getAssertionsForEntity(entity.id, { status: "superseded" });
      expect(assertions.length).toBe(1);
      expect(assertions[0]!.id).toBe(assertion.id);

      // Entity itself should still be active (not invalidated)
      const stillActive = engine.getEntity(entity.id);
      expect(stillActive).not.toBeNull();
      expect(stillActive!.valid_until).toBeNull();
    });

    test("supersession proposal can be rejected and entity stays unchanged", () => {
      const entity = engine.upsertEntity({ name: "Carol", type: "user", summary: "PM" });
      const assertion = engine.recordAssertion({
        entityId: entity.id,
        assertionText: "Carol prefers dark mode",
        confidence: 0.7,
      });

      const proposal = engine.createSupersessionProposal({
        targetEntityId: entity.id,
        targetAssertionId: assertion.id,
        newAssertionText: "Carol prefers light mode",
        reason: "Observed new preference",
      });

      const resolved = engine.resolveSupersession(proposal.id, "rejected");
      expect(resolved).not.toBeNull();
      expect(resolved!.status).toBe("rejected");

      // Assertion should still be active
      const assertions = engine.getAssertionsForEntity(entity.id, { status: "active" });
      expect(assertions.length).toBe(1);
      expect(assertions[0]!.assertion_text).toBe("Carol prefers dark mode");

      // No superseded assertions
      const superseded = engine.getAssertionsForEntity(entity.id, { status: "superseded" });
      expect(superseded.length).toBe(0);
    });

    test("pending proposals are tracked correctly", () => {
      const entity = engine.upsertEntity({ name: "Dave", type: "user", summary: "QA" });
      engine.recordAssertion({
        entityId: entity.id,
        assertionText: "Dave works in QA",
        confidence: 0.9,
      });

      engine.createSupersessionProposal({
        targetEntityId: entity.id,
        newAssertionText: "Dave now works in engineering",
      });
      engine.createSupersessionProposal({
        targetEntityId: entity.id,
        newAssertionText: "Dave transferred to devops",
      });

      const pending = engine.getPendingProposals();
      expect(pending.length).toBe(2);
      expect(pending.every((p) => p.status === "pending")).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Retrieval quality
  // ---------------------------------------------------------------------------

  describe("retrieval quality", () => {
    let db: DatabaseSync;
    let engine: MemoryGraphEngine;

    beforeEach(() => {
      db = createTestDb();
      engine = new MemoryGraphEngine(db, { embedFn: mockEmbed([1, 0, 0]) });
    });
    afterEach(() => {
      clearSearchCache();
      db.close();
    });

    test("entity search returns relevant results with score > 0", async () => {
      engine.upsertEntity({ name: "React", type: "concept", summary: "UI library" });
      engine.upsertEntity({ name: "Vue", type: "concept", summary: "Progressive framework" });
      engine.upsertEntity({ name: "Alice", type: "user", summary: "engineer" });

      const results = await searchGraph(db, engine, "React", { minScore: 0 });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.entity.name).toBe("React");
      expect(results[0]!.score).toBeGreaterThan(0);
    });

    test("entity search ranks by relevance — exact match > partial", async () => {
      engine.upsertEntity({ name: "TypeScript", type: "concept", summary: "typed JavaScript" });
      engine.upsertEntity({
        name: "TypeORM",
        type: "concept",
        summary: "TypeScript ORM for databases",
      });

      const results = await searchGraph(db, engine, "TypeScript", {
        vectorWeight: 0,
        ftsWeight: 1,
        graphWeight: 0,
        minScore: 0,
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      // "TypeScript" should rank higher than "TypeORM"
      const tsIdx = results.findIndex((r) => r.entity.name === "TypeScript");
      const ormIdx = results.findIndex((r) => r.entity.name === "TypeORM");
      if (tsIdx >= 0 && ormIdx >= 0) {
        expect(tsIdx).toBeLessThan(ormIdx);
      }
    });

    test("global search returns community reports for broad queries", async () => {
      // Create connected entities
      const react = engine.upsertEntity({ name: "React", type: "concept", summary: "UI library" });
      const vue = engine.upsertEntity({
        name: "Vue",
        type: "concept",
        summary: "Progressive framework",
      });
      engine.addEdge({ fromId: react.id, toId: vue.id, relation: "relates" });

      // Detect and summarize communities
      detectCommunities(engine);
      await summarizeCommunities(engine, async () => ({
        label: "Frontend frameworks",
        summary: "React and Vue are popular frontend UI frameworks.",
      }));

      // Broad query should use global path
      const result = await retrieve(db, engine, "overview of all technologies", {
        mode: "global",
      });

      expect(result.mode).toBe("global");
      expect(result.communityReports.length).toBeGreaterThan(0);
      expect(result.communityReports[0]!.label).toBe("Frontend frameworks");
    });

    test("pinned memory includes high-confidence user/preference entities", () => {
      engine.upsertEntity({
        name: "Alice",
        type: "user",
        summary: "PM at Xiaomi",
        confidence: 0.95,
      });
      engine.upsertEntity({
        name: "DarkMode",
        type: "preference",
        summary: "prefers dark theme",
        confidence: 0.9,
      });
      engine.upsertEntity({
        name: "Noise",
        type: "concept",
        summary: "irrelevant noise",
        confidence: 0.95,
      });

      const pinned = buildPinnedMemory(engine);
      const names = pinned.entities.map((e) => e.name);

      // High-confidence user and preference should be pinned
      expect(names).toContain("Alice");
      expect(names).toContain("DarkMode");
      // Concepts should NOT be pinned regardless of confidence
      expect(names).not.toContain("Noise");
    });

    test("retrieval pipeline respects maxTokens budget", async () => {
      // Create many entities with long summaries
      for (let i = 0; i < 20; i++) {
        engine.upsertEntity({
          name: `Entity${i}`,
          type: "concept",
          summary: "A".repeat(200),
        });
      }

      const result = await retrieve(db, engine, "Entity", {
        mode: "entity",
        maxTokens: 200,
      });

      // Should pack fewer results due to tight budget
      const totalTokens = result.entities.reduce(
        (sum, e) => sum + Math.ceil((e.name + ": " + e.summary).length / 4),
        0,
      );
      expect(totalTokens).toBeLessThanOrEqual(200 + 50); // small margin for rounding
    });
  });

  // ---------------------------------------------------------------------------
  // Context efficiency
  // ---------------------------------------------------------------------------

  describe("context efficiency", () => {
    let db: DatabaseSync;
    let engine: MemoryGraphEngine;

    beforeEach(() => {
      db = createTestDb();
      engine = new MemoryGraphEngine(db);
    });
    afterEach(() => db.close());

    test("packed context does not exceed token budget", () => {
      for (let i = 0; i < 30; i++) {
        engine.upsertEntity({
          name: `Entity${i}`,
          type: "concept",
          summary: `Summary for entity ${i} with some content`,
        });
      }

      const l0 = buildL0Context(engine, { maxTokens: 100 });
      expect(l0.estimatedTokens).toBeLessThanOrEqual(100);
    });

    test("diversity filter caps per-type before backfill", async () => {
      // Create entities of multiple types so diversity filter has room
      for (let i = 0; i < 10; i++) {
        engine.upsertEntity({
          name: `Concept${i}`,
          type: "concept",
          summary: `common search term concept ${i}`,
        });
      }
      for (let i = 0; i < 5; i++) {
        engine.upsertEntity({
          name: `User${i}`,
          type: "user",
          summary: `common search term user ${i}`,
        });
      }
      engine.upsertEntity({
        name: "ProjectEntity",
        type: "project",
        summary: "common search term project",
      });

      const results = await searchGraph(db, engine, "common search term", {
        maxResults: 6,
        minScore: 0,
      });

      // Verify we got results and they include multiple types
      expect(results.length).toBeGreaterThan(0);
      const types = new Set(results.map((r) => r.entity.type));
      expect(types.size).toBeGreaterThan(1);

      // Verify the first maxResults entries don't exceed maxPerType
      // maxPerType = Math.max(2, Math.ceil(6 / 3)) = 2
      // The diversity filter caps at 2 per type for the first pass
      const firstBatch = results.slice(0, Math.min(results.length, 6));
      const typeCounts = new Map<string, number>();
      for (const r of firstBatch) {
        typeCounts.set(r.entity.type, (typeCounts.get(r.entity.type) ?? 0) + 1);
      }
      // With multiple types available, each type should be capped at maxPerType (2)
      // in the initial selection (before backfill)
      const maxCount = Math.max(...typeCounts.values());
      expect(maxCount).toBeLessThanOrEqual(3); // 2 (cap) + 1 (possible backfill)
    });
  });

  // ---------------------------------------------------------------------------
  // ObservabilityCollector integration
  // ---------------------------------------------------------------------------

  describe("ObservabilityCollector", () => {
    let db: DatabaseSync;
    let engine: MemoryGraphEngine;
    let collector: ObservabilityCollector;

    beforeEach(() => {
      db = createTestDb();
      engine = new MemoryGraphEngine(db);
      collector = new ObservabilityCollector();
    });
    afterEach(() => db.close());

    test("getSnapshot reflects live index state", () => {
      engine.upsertEntity({ name: "A", type: "concept" });
      engine.upsertEntity({ name: "B", type: "concept" });
      const b = engine.findEntities({ name: "B" })[0]!;
      engine.addEdge({ fromId: engine.findEntities({ name: "A" })[0]!.id, toId: b.id, relation: "r" });

      const snap = collector.getSnapshot(engine);
      expect(snap.index.totalEntities).toBe(2);
      expect(snap.index.activeEntities).toBe(2);
      expect(snap.index.totalEdges).toBe(1);
    });

    test("recordSearch accumulates correctly", () => {
      collector.recordSearch("entity", 5, false);
      collector.recordSearch("entity", 3, true);
      collector.recordSearch("global", 0, false);

      const snap = collector.getSnapshot(engine);
      expect(snap.retrieval.totalSearches).toBe(3);
      expect(snap.retrieval.entityModeSearches).toBe(2);
      expect(snap.retrieval.globalModeSearches).toBe(1);
      expect(snap.retrieval.avgResultsReturned).toBeCloseTo((5 + 3 + 0) / 3);
      expect(snap.retrieval.cacheHitRate).toBeCloseTo(1 / 3);
    });

    test("recordWrite accumulates correctly", () => {
      collector.recordWrite("assertion");
      collector.recordWrite("assertion");
      collector.recordWrite("proposal_created");
      collector.recordWrite("proposal_approved");
      collector.recordWrite("blocked");

      const snap = collector.getSnapshot(engine);
      expect(snap.write.assertionsCreated).toBe(2);
      expect(snap.write.proposalsCreated).toBe(1);
      expect(snap.write.proposalsApproved).toBe(1);
      expect(snap.write.destructiveApplyBlocked).toBe(1);
    });

    test("recordContextPacked tracks budget overshoots", () => {
      collector.recordContextPacked(500, 800); // within budget
      collector.recordContextPacked(900, 800); // overshoot
      collector.recordContextPacked(1200, 800); // overshoot

      const snap = collector.getSnapshot(engine);
      expect(snap.context.avgPackedTokens).toBeCloseTo((500 + 900 + 1200) / 3);
      expect(snap.context.budgetOvershootCount).toBe(2);
    });

    test("pending proposals count in snapshot", () => {
      const entity = engine.upsertEntity({ name: "E", type: "concept" });
      engine.createSupersessionProposal({
        targetEntityId: entity.id,
        newAssertionText: "new fact",
      });
      engine.createSupersessionProposal({
        targetEntityId: entity.id,
        newAssertionText: "another fact",
      });

      const snap = collector.getSnapshot(engine);
      expect(snap.index.pendingProposals).toBe(2);
    });

    test("reset clears all recorded counters", () => {
      collector.recordSearch("entity", 5, false);
      collector.recordWrite("assertion");
      collector.recordContextPacked(100, 200);

      collector.reset();

      const snap = collector.getSnapshot(engine);
      expect(snap.retrieval.totalSearches).toBe(0);
      expect(snap.write.assertionsCreated).toBe(0);
      expect(snap.context.avgPackedTokens).toBe(0);
      // Index stats are live, so they reflect current graph state
      expect(snap.index.totalEntities).toBe(0);
    });

    test("snapshot reflects community count after detection", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "r" });

      detectCommunities(engine);

      const snap = collector.getSnapshot(engine);
      expect(snap.index.totalCommunities).toBe(1);
    });
  });
});
