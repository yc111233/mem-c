import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import { detectCommunities, getCommunities, getCommunityForEntity } from "../host/graph-community.js";
import { createTestDb } from "./test-helpers.js";

describe("community detection", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  describe("detectCommunities", () => {
    it("finds a single connected component", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      const c = engine.upsertEntity({ name: "C", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });
      engine.addEdge({ fromId: b.id, toId: c.id, relation: "relates" });

      const result = detectCommunities(engine);
      expect(result.communities.length).toBe(1);
      expect(result.communities[0]!.entityCount).toBe(3);
      expect(result.totalEntities).toBe(3);
    });

    it("finds multiple disconnected components", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

      const c = engine.upsertEntity({ name: "C", type: "concept" });
      const d = engine.upsertEntity({ name: "D", type: "concept" });
      engine.addEdge({ fromId: c.id, toId: d.id, relation: "relates" });

      engine.upsertEntity({ name: "E", type: "concept" }); // isolated

      const result = detectCommunities(engine);
      expect(result.communities.length).toBe(3);
      const sizes = result.communities.map((c) => c.entityCount).sort();
      expect(sizes).toEqual([1, 2, 2]);
    });

    it("handles empty graph", () => {
      const result = detectCommunities(engine);
      expect(result.communities.length).toBe(0);
      expect(result.totalEntities).toBe(0);
    });

    it("respects activeOnly flag", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });
      engine.invalidateEntity(a.id);

      const result = detectCommunities(engine, { activeOnly: true });
      expect(result.communities.length).toBe(1);
      expect(result.communities[0]!.entityCount).toBe(1);
    });

    it("stores results in database", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

      detectCommunities(engine);

      const stored = getCommunities(engine);
      expect(stored.length).toBe(1);
      expect(stored[0]!.entityCount).toBe(2);
    });

    it("clears old communities on re-detect", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

      detectCommunities(engine);
      detectCommunities(engine); // re-run

      const stored = getCommunities(engine);
      expect(stored.length).toBe(1); // not 2
    });
  });

  describe("getCommunityForEntity", () => {
    it("returns community for a given entity", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

      detectCommunities(engine);

      const community = getCommunityForEntity(engine, a.id);
      expect(community).not.toBeNull();
      expect(community!.entityCount).toBe(2);
    });

    it("returns null for entity not in any community", () => {
      const community = getCommunityForEntity(engine, "nonexistent");
      expect(community).toBeNull();
    });
  });
});
