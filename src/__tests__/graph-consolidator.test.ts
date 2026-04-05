import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import { ensureGraphSchema } from "../host/graph-schema.js";
import { consolidateGraph } from "../host/graph-consolidator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureGraphSchema({ db, ftsEnabled: true });
  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("consolidateGraph", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("merge phase", () => {
    it("merges same-name entities with different types", () => {
      engine.upsertEntity({ name: "React", type: "concept", summary: "UI lib", confidence: 0.9 });
      engine.upsertEntity({ name: "React", type: "tool", summary: "Build tool", confidence: 0.5 });

      const result = consolidateGraph(engine);
      expect(result.merged).toBe(1);
      expect(result.errors).toHaveLength(0);

      // Only one active React should remain
      const active = engine.getActiveEntities();
      const reacts = active.filter((e) => e.name === "React");
      expect(reacts).toHaveLength(1);
      expect(reacts[0]!.confidence).toBe(0.9); // keeper has higher confidence
    });

    it("reassigns edges when merging", () => {
      const r1 = engine.upsertEntity({ name: "React", type: "concept", confidence: 0.9 });
      const r2 = engine.upsertEntity({ name: "React", type: "tool", confidence: 0.5 });
      const ts = engine.upsertEntity({ name: "TypeScript", type: "concept" });
      engine.addEdge({ fromId: r2.id, toId: ts.id, relation: "uses" });

      consolidateGraph(engine);

      // Edge should now point from r1 (keeper) to ts
      const edges = engine.findEdges({ entityId: r1.id, activeOnly: true });
      expect(edges.length).toBeGreaterThanOrEqual(1);
    });

    it("does not merge when only one entity per name", () => {
      engine.upsertEntity({ name: "React", type: "concept" });
      engine.upsertEntity({ name: "Vue", type: "concept" });

      const result = consolidateGraph(engine);
      expect(result.merged).toBe(0);
    });
  });

  describe("decay phase", () => {
    it("decays entities not accessed for a long time", () => {
      const e = engine.upsertEntity({ name: "OldThing", type: "concept", confidence: 1.0 });
      // Manually set updated_at to 60 days ago
      const sixtyDaysAgo = Date.now() - 60 * 86_400_000;
      db.prepare(`UPDATE entities SET updated_at = ?, last_accessed_at = 0 WHERE id = ?`)
        .run(sixtyDaysAgo, e.id);

      const result = consolidateGraph(engine, { decayAfterDays: 30 });
      expect(result.decayed).toBe(1);

      const updated = engine.getEntity(e.id)!;
      expect(updated.confidence).toBeLessThan(1.0);
      expect(updated.confidence).toBeCloseTo(0.8, 1); // never-accessed decay factor
    });

    it("does not decay recently updated entities", () => {
      engine.upsertEntity({ name: "Fresh", type: "concept", confidence: 1.0 });

      const result = consolidateGraph(engine, { decayAfterDays: 30 });
      expect(result.decayed).toBe(0);
    });
  });

  describe("prune phase", () => {
    it("prunes low-confidence orphans", () => {
      const e = engine.upsertEntity({ name: "Garbage", type: "concept", confidence: 0.2 });
      // No edges — it's an orphan

      const result = consolidateGraph(engine, { pruneThreshold: 0.3 });
      expect(result.pruned).toBe(1);

      // Entity should be invalidated
      const entity = engine.getEntity(e.id)!;
      expect(entity.valid_until).not.toBeNull();
    });

    it("does not prune connected low-confidence entities", () => {
      const e1 = engine.upsertEntity({ name: "Weak", type: "concept", confidence: 0.2 });
      const e2 = engine.upsertEntity({ name: "Strong", type: "concept", confidence: 1.0 });
      engine.addEdge({ fromId: e1.id, toId: e2.id, relation: "relates" });

      const result = consolidateGraph(engine, { pruneThreshold: 0.3 });
      expect(result.pruned).toBe(0);
    });

    it("does not prune entities above threshold", () => {
      engine.upsertEntity({ name: "OK", type: "concept", confidence: 0.5 });

      const result = consolidateGraph(engine, { pruneThreshold: 0.3 });
      expect(result.pruned).toBe(0);
    });
  });

  describe("dry run", () => {
    it("reports changes without modifying", () => {
      engine.upsertEntity({ name: "React", type: "concept", confidence: 0.9 });
      engine.upsertEntity({ name: "React", type: "tool", confidence: 0.5 });
      engine.upsertEntity({ name: "Orphan", type: "concept", confidence: 0.1 });

      const result = consolidateGraph(engine, { dryRun: true, pruneThreshold: 0.3 });
      expect(result.merged).toBe(1);
      expect(result.pruned).toBe(1);

      // Nothing actually changed
      const active = engine.getActiveEntities();
      expect(active.filter((e) => e.name === "React")).toHaveLength(2);
      expect(active.filter((e) => e.name === "Orphan")).toHaveLength(1);
    });
  });

  describe("full pipeline", () => {
    it("runs all phases together", () => {
      // Merge target
      engine.upsertEntity({ name: "React", type: "concept", confidence: 0.9 });
      engine.upsertEntity({ name: "React", type: "tool", confidence: 0.5 });

      // Decay target
      const old = engine.upsertEntity({ name: "Legacy", type: "concept", confidence: 0.8 });
      db.prepare(`UPDATE entities SET updated_at = ?, last_accessed_at = 0 WHERE id = ?`)
        .run(Date.now() - 60 * 86_400_000, old.id);

      // Prune target (low confidence orphan)
      engine.upsertEntity({ name: "Noise", type: "concept", confidence: 0.1 });

      const result = consolidateGraph(engine, { decayAfterDays: 30, pruneThreshold: 0.3 });
      expect(result.merged).toBe(1);
      expect(result.decayed).toBeGreaterThanOrEqual(1);
      expect(result.pruned).toBeGreaterThanOrEqual(1);
      expect(result.errors).toHaveLength(0);
    });
  });
});
