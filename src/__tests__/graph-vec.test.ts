import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createTestDb } from "./test-helpers.js";
import {
  ensureVecIndex,
  vecUpsert,
  vecRemove,
  vecKnn,
  vecSyncAll,
} from "../host/graph-vec.js";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import { ensureGraphSchema } from "../host/graph-schema.js";

const DIMS = 1536; // Must match ensureGraphSchema default vecDimensions

/** Create a sparse embedding with 1.0 at the given index, 0 elsewhere. */
function sparseVec(index: number): number[] {
  const vec = new Array(DIMS).fill(0);
  vec[index] = 1.0;
  return vec;
}

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

      const e1 = engine.upsertEntity({ name: "alpha", type: "concept", embedding: sparseVec(0) });
      const e2 = engine.upsertEntity({ name: "beta", type: "concept", embedding: sparseVec(1) });
      const e3 = engine.upsertEntity({ name: "gamma", type: "concept", embedding: sparseVec(2) });

      vecUpsert(db, e1.id, sparseVec(0), true);
      vecUpsert(db, e2.id, sparseVec(1), true);
      vecUpsert(db, e3.id, sparseVec(2), true);

      const results = vecKnn(db, sparseVec(0), 3, true);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.id).toBe(e1.id);

      for (let i = 1; i < results.length; i++) {
        expect(results[i]!.distance).toBeGreaterThanOrEqual(results[i - 1]!.distance);
      }
    });

    it("returns empty array when available=false", () => {
      const db = createTestDb();
      const results = vecKnn(db, sparseVec(0), 5, false);
      expect(results).toEqual([]);
    });
  });

  describe("vecRemove", () => {
    it("removes entity from vec index", () => {
      const db = createTestDb();
      const { available } = ensureVecIndex(db, DIMS);
      if (!available) return;

      const engine = new MemoryGraphEngine(db);
      const entity = engine.upsertEntity({ name: "to-remove", type: "concept", embedding: sparseVec(0) });
      vecUpsert(db, entity.id, sparseVec(0), true);

      let results = vecKnn(db, sparseVec(0), 5, true);
      expect(results.some((r) => r.id === entity.id)).toBe(true);

      vecRemove(db, entity.id, true);

      results = vecKnn(db, sparseVec(0), 5, true);
      expect(results.some((r) => r.id === entity.id)).toBe(false);
    });
  });

  describe("vecSyncAll", () => {
    it("syncs entities with embeddings into vec index", () => {
      const db = createTestDb();
      const { available } = ensureVecIndex(db, DIMS);
      if (!available) return;

      const engine = new MemoryGraphEngine(db);
      engine.upsertEntity({ name: "sync-a", type: "concept", embedding: sparseVec(0) });
      engine.upsertEntity({ name: "sync-b", type: "concept", embedding: sparseVec(1) });

      const count = vecSyncAll(db, true);
      expect(count).toBe(2);

      const results = vecKnn(db, sparseVec(0), 5, true);
      expect(results.length).toBe(2);
    });

    it("returns 0 when available=false", () => {
      const db = createTestDb();
      const count = vecSyncAll(db, false);
      expect(count).toBe(0);
    });
  });

  describe("engine integration", () => {
    it("syncs vec on entity upsert when vec is available", () => {
      const db = new DatabaseSync(":memory:", { allowExtension: true });
      const eng = new MemoryGraphEngine(db);
      const schemaResult = ensureGraphSchema({ db, engine: eng });
      if (!schemaResult.vecAvailable) return;

      eng.upsertEntity({ name: "Test", type: "concept", embedding: sparseVec(0) });

      const results = vecKnn(db, sparseVec(0), 1, true);
      expect(results.length).toBe(1);
    });

    it("removes from vec on entity invalidation", () => {
      const db = new DatabaseSync(":memory:", { allowExtension: true });
      const eng = new MemoryGraphEngine(db);
      const schemaResult = ensureGraphSchema({ db, engine: eng });
      if (!schemaResult.vecAvailable) return;

      const entity = eng.upsertEntity({ name: "Test", type: "concept", embedding: sparseVec(0) });
      eng.invalidateEntity(entity.id);

      const results = vecKnn(db, sparseVec(0), 1, true);
      expect(results.find((r) => r.id === entity.id)).toBeUndefined();
    });
  });
});
