import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import { createTestDb } from "./test-helpers.js";

describe("multi-hop path finding", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  describe("findPaths", () => {
    it("finds direct path (1 hop)", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

      const paths = engine.findPaths(a.id, b.id, { maxDepth: 3 });
      expect(paths.length).toBeGreaterThanOrEqual(1);
      expect(paths[0]!.steps.length).toBe(1);
      expect(paths[0]!.steps[0]!.fromName).toBe("A");
      expect(paths[0]!.steps[0]!.toName).toBe("B");
      expect(paths[0]!.steps[0]!.relation).toBe("relates");
    });

    it("finds 2-hop path", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      const c = engine.upsertEntity({ name: "C", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "knows" });
      engine.addEdge({ fromId: b.id, toId: c.id, relation: "works_on" });

      const paths = engine.findPaths(a.id, c.id, { maxDepth: 3 });
      expect(paths.length).toBeGreaterThanOrEqual(1);
      expect(paths[0]!.steps.length).toBe(2);
      expect(paths[0]!.steps[0]!.fromName).toBe("A");
      expect(paths[0]!.steps[1]!.toName).toBe("C");
    });

    it("finds multiple paths", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      const c = engine.upsertEntity({ name: "C", type: "concept" });
      const d = engine.upsertEntity({ name: "D", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "r1" });
      engine.addEdge({ fromId: b.id, toId: d.id, relation: "r2" });
      engine.addEdge({ fromId: a.id, toId: c.id, relation: "r3" });
      engine.addEdge({ fromId: c.id, toId: d.id, relation: "r4" });

      const paths = engine.findPaths(a.id, d.id, { maxDepth: 3 });
      expect(paths.length).toBe(2);
      expect(paths[0]!.steps.length).toBeLessThanOrEqual(paths[1]!.steps.length);
    });

    it("respects maxDepth", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      const c = engine.upsertEntity({ name: "C", type: "concept" });
      const d = engine.upsertEntity({ name: "D", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "r1" });
      engine.addEdge({ fromId: b.id, toId: c.id, relation: "r2" });
      engine.addEdge({ fromId: c.id, toId: d.id, relation: "r3" });

      const paths2 = engine.findPaths(a.id, d.id, { maxDepth: 2 });
      expect(paths2.length).toBe(0);

      const paths3 = engine.findPaths(a.id, d.id, { maxDepth: 3 });
      expect(paths3.length).toBe(1);
    });

    it("respects maxPaths limit", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      const c = engine.upsertEntity({ name: "C", type: "concept" });
      const d = engine.upsertEntity({ name: "D", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "r1" });
      engine.addEdge({ fromId: b.id, toId: d.id, relation: "r2" });
      engine.addEdge({ fromId: a.id, toId: c.id, relation: "r3" });
      engine.addEdge({ fromId: c.id, toId: d.id, relation: "r4" });

      const paths = engine.findPaths(a.id, d.id, { maxDepth: 3, maxPaths: 1 });
      expect(paths.length).toBe(1);
    });

    it("returns empty when no path exists", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      const paths = engine.findPaths(a.id, b.id, { maxDepth: 3 });
      expect(paths.length).toBe(0);
    });

    it("returns empty for same source and target", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const paths = engine.findPaths(a.id, a.id, { maxDepth: 3 });
      expect(paths.length).toBe(0);
    });

    it("handles nonexistent entities", () => {
      const paths = engine.findPaths("nonexistent1", "nonexistent2", { maxDepth: 3 });
      expect(paths.length).toBe(0);
    });
  });
});
