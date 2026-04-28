import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import {
  inferRelationTypes,
  type InferRelationFn,
} from "../host/graph-inference.js";
import { createTestDb } from "./test-helpers.js";

describe("relation type inference", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  describe("inferRelationTypes", () => {
    it("calls inferFn for each generic-relation edge and returns suggestions", async () => {
      const a = engine.upsertEntity({ name: "Alice", type: "user", summary: "developer" });
      const b = engine.upsertEntity({ name: "React", type: "concept", summary: "UI library" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates_to" });

      const mockInfer: InferRelationFn = async () => {
        return { relation: "uses", confidence: 0.9, reason: "Developer uses framework" };
      };

      const result = await inferRelationTypes(engine, mockInfer);

      expect(result.suggestions.length).toBe(1);
      expect(result.suggestions[0]!.suggestedRelation).toBe("uses");
      expect(result.suggestions[0]!.confidence).toBe(0.9);
      expect(result.analyzed).toBe(1);
    });

    it("skips edges with specific relation types", async () => {
      const a = engine.upsertEntity({ name: "Alice", type: "user" });
      const b = engine.upsertEntity({ name: "React", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "works_on" });

      const mockInfer: InferRelationFn = async () => ({ relation: "uses", confidence: 0.9 });

      const result = await inferRelationTypes(engine, mockInfer);
      expect(result.analyzed).toBe(0);
    });

    it("respects targetRelations option", async () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "custom_generic" });

      const mockInfer: InferRelationFn = async () => ({ relation: "specific", confidence: 0.8 });

      const result = await inferRelationTypes(engine, mockInfer, {
        targetRelations: ["custom_generic"],
      });
      expect(result.analyzed).toBe(1);
    });

    it("handles inferFn errors gracefully", async () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates_to" });

      const mockInfer: InferRelationFn = async () => {
        throw new Error("LLM error");
      };

      const result = await inferRelationTypes(engine, mockInfer);
      expect(result.suggestions.length).toBe(0);
      expect(result.errors.length).toBe(1);
    });

    it("returns empty when no edges match", async () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "works_on" });

      const mockInfer: InferRelationFn = async () => ({ relation: "x", confidence: 0.5 });

      const result = await inferRelationTypes(engine, mockInfer);
      expect(result.analyzed).toBe(0);
      expect(result.suggestions.length).toBe(0);
    });

    it("applySuggestions updates edge relations", async () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates_to" });

      const mockInfer: InferRelationFn = async () => ({ relation: "depends_on", confidence: 0.85 });

      const result = await inferRelationTypes(engine, mockInfer);

      result.applySuggestions(engine);

      const edges = engine.findEdges({ entityId: a.id });
      expect(edges.length).toBe(1);
      expect(edges[0]!.relation).toBe("depends_on");
    });
  });
});
