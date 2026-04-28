import { describe, it, expect } from "vitest";
import { createTestDb } from "./test-helpers.js";
import {
  ensureVecIndex,
  vecUpsert,
  vecRemove,
  vecKnn,
  vecSyncAll,
} from "../host/graph-vec.js";
import { MemoryGraphEngine } from "../host/graph-engine.js";

const DIMS = 4;

describe("graph-vec", () => {
  describe("ensureVecIndex", () => {
    it("returns availability status with available boolean", () => {
      const db = createTestDb();
      const result = ensureVecIndex(db, DIMS);
      expect(result).toHaveProperty("available");
      expect(typeof result.available).toBe("boolean");
    });
  });

  describe("vecKnn", () => {
    it("returns nearest neighbors sorted by distance", () => {
      const db = createTestDb();
      const { available } = ensureVecIndex(db, DIMS);
      if (!available) return;

      const engine = new MemoryGraphEngine(db);

      // Insert entities with embeddings
      const e1 = engine.upsertEntity({
        name: "alpha",
        type: "concept",
        embedding: [1, 0, 0, 0],
      });
      const e2 = engine.upsertEntity({
        name: "beta",
        type: "concept",
        embedding: [0, 1, 0, 0],
      });
      const e3 = engine.upsertEntity({
        name: "gamma",
        type: "concept",
        embedding: [0, 0, 1, 0],
      });

      // Upsert into vec index
      vecUpsert(db, e1.id, [1, 0, 0, 0], true);
      vecUpsert(db, e2.id, [0, 1, 0, 0], true);
      vecUpsert(db, e3.id, [0, 0, 1, 0], true);

      // Query nearest to [1, 0, 0, 0] — alpha should be closest
      const results = vecKnn(db, [1, 0, 0, 0], 3, true);
      expect(results.length).toBeGreaterThan(0);

      // First result should be alpha (distance 0 or near-0)
      expect(results[0]!.id).toBe(e1.id);

      // Results should be sorted by distance ascending
      for (let i = 1; i < results.length; i++) {
        expect(results[i]!.distance).toBeGreaterThanOrEqual(results[i - 1]!.distance);
      }
    });

    it("returns empty array when available=false", () => {
      const db = createTestDb();
      const results = vecKnn(db, [1, 0, 0, 0], 5, false);
      expect(results).toEqual([]);
    });
  });

  describe("vecRemove", () => {
    it("removes entity from vec index", () => {
      const db = createTestDb();
      const { available } = ensureVecIndex(db, DIMS);
      if (!available) return;

      const engine = new MemoryGraphEngine(db);
      const entity = engine.upsertEntity({
        name: "to-remove",
        type: "concept",
        embedding: [1, 0, 0, 0],
      });

      vecUpsert(db, entity.id, [1, 0, 0, 0], true);

      // Confirm it's in the index
      let results = vecKnn(db, [1, 0, 0, 0], 5, true);
      expect(results.some((r) => r.id === entity.id)).toBe(true);

      // Remove it
      vecRemove(db, entity.id, true);

      // Confirm it's gone
      results = vecKnn(db, [1, 0, 0, 0], 5, true);
      expect(results.some((r) => r.id === entity.id)).toBe(false);
    });
  });

  describe("vecSyncAll", () => {
    it("syncs entities with embeddings into vec index", () => {
      const db = createTestDb();
      const { available } = ensureVecIndex(db, DIMS);
      if (!available) return;

      const engine = new MemoryGraphEngine(db);
      engine.upsertEntity({
        name: "sync-a",
        type: "concept",
        embedding: [1, 0, 0, 0],
      });
      engine.upsertEntity({
        name: "sync-b",
        type: "concept",
        embedding: [0, 1, 0, 0],
      });

      const count = vecSyncAll(db, true);
      expect(count).toBe(2);

      // Verify they're queryable
      const results = vecKnn(db, [1, 0, 0, 0], 5, true);
      expect(results.length).toBe(2);
    });

    it("returns 0 when available=false", () => {
      const db = createTestDb();
      const count = vecSyncAll(db, false);
      expect(count).toBe(0);
    });
  });
});
