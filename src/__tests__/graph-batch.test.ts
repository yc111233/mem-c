import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine, type EmbedFn } from "../host/graph-engine.js";
import { createTestDb } from "./test-helpers.js";

describe("batch operations", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  describe("upsertEntities", () => {
    it("creates multiple entities in one transaction", () => {
      const results = engine.upsertEntities([
        { name: "A", type: "concept" },
        { name: "B", type: "user" },
        { name: "C", type: "project" },
      ]);

      expect(results.length).toBe(3);
      expect(results[0]!.isNew).toBe(true);
      expect(results[1]!.isNew).toBe(true);
      expect(results[2]!.isNew).toBe(true);

      const stats = engine.stats();
      expect(stats.entities).toBe(3);
    });

    it("updates existing entities on re-run", () => {
      engine.upsertEntities([
        { name: "A", type: "concept", summary: "v1" },
      ]);

      const results = engine.upsertEntities([
        { name: "A", type: "concept", summary: "v2" },
      ]);

      expect(results[0]!.isNew).toBe(false);
      expect(results[0]!.summary).toBe("v2");
    });

    it("calls embedFn for each entity", () => {
      let callCount = 0;
      const countingEmbed: EmbedFn = (text) => {
        callCount++;
        return [1, 0, 0];
      };
      const embedEngine = new MemoryGraphEngine(db, { embedFn: countingEmbed });

      embedEngine.upsertEntities([
        { name: "A", type: "concept" },
        { name: "B", type: "concept" },
        { name: "C", type: "concept" },
      ]);

      expect(callCount).toBe(3);
    });
  });

  describe("addEdges", () => {
    it("creates multiple edges in one transaction", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      const c = engine.upsertEntity({ name: "C", type: "concept" });

      const edges = engine.addEdges([
        { fromId: a.id, toId: b.id, relation: "relates_to" },
        { fromId: b.id, toId: c.id, relation: "depends_on" },
      ]);

      expect(edges.length).toBe(2);
      expect(edges[0]!.relation).toBe("relates_to");
      expect(edges[1]!.relation).toBe("depends_on");
    });

    it("deduplicates edges within the batch", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });

      engine.addEdges([
        { fromId: a.id, toId: b.id, relation: "relates_to", weight: 0.5 },
        { fromId: a.id, toId: b.id, relation: "relates_to", weight: 0.8 },
      ]);

      const found = engine.findEdges({ entityId: a.id });
      expect(found.length).toBe(1);
      expect(found[0]!.weight).toBe(0.8);
    });
  });
});
