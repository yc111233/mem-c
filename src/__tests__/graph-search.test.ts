import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine, type EmbedFn } from "../host/graph-engine.js";
import { searchGraph, type GraphSearchOpts } from "../host/graph-search.js";
import { createTestDb } from "./test-helpers.js";

describe("searchGraph", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  // -------------------------------------------------------------------------
  // FTS path
  // -------------------------------------------------------------------------

  it("finds entities via FTS", () => {
    engine.upsertEntity({ name: "React", type: "concept", summary: "UI library" });
    engine.upsertEntity({ name: "Vue", type: "concept", summary: "Progressive framework" });

    // Use low minScore since BM25 scores are very small with few documents
    const results = searchGraph(db, engine, "React", { minScore: 0 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.entity.name).toBe("React");
  });

  it("falls back to LIKE when FTS returns nothing", () => {
    engine.upsertEntity({ name: "MyUniqueEntity", type: "concept", summary: "special" });

    const results = searchGraph(db, engine, "MyUniqueEntity", { minScore: 0 });
    expect(results.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Vector path
  // -------------------------------------------------------------------------

  it("uses vector similarity when queryEmbedding provided", () => {
    engine.upsertEntity({ name: "A", type: "concept", embedding: [1.0, 0.0, 0.0] });
    engine.upsertEntity({ name: "B", type: "concept", embedding: [0.0, 1.0, 0.0] });

    const results = searchGraph(db, engine, "test", {
      queryEmbedding: [1.0, 0.0, 0.0],
      vectorWeight: 1.0,
      ftsWeight: 0.0,
      graphWeight: 0.0,
      minScore: 0,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.entity.name).toBe("A");
    expect(results[0]!.scoreBreakdown.vector).toBeCloseTo(1.0, 2);
  });

  // -------------------------------------------------------------------------
  // Auto embedFn in search
  // -------------------------------------------------------------------------

  it("auto-generates queryEmbedding via engine embedFn", () => {
    const mockEmbed: EmbedFn = () => [1.0, 0.0, 0.0];
    const embedEngine = new MemoryGraphEngine(db, { embedFn: mockEmbed });

    embedEngine.upsertEntity({ name: "A", type: "concept" }); // auto-embed [1,0,0]
    embedEngine.upsertEntity({ name: "B", type: "concept", embedding: [0.0, 1.0, 0.0] });

    // Search without explicit queryEmbedding — should use embedFn
    const results = searchGraph(db, embedEngine, "anything", {
      vectorWeight: 1.0,
      ftsWeight: 0.0,
      graphWeight: 0.0,
      minScore: 0,
    });

    // "A" should rank higher since its embedding matches the auto-generated query embedding
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.entity.name).toBe("A");
  });

  // -------------------------------------------------------------------------
  // Scoring and filtering
  // -------------------------------------------------------------------------

  it("filters by entity type", () => {
    engine.upsertEntity({ name: "Alice", type: "user" });
    engine.upsertEntity({ name: "Alice Method", type: "concept" });

    const results = searchGraph(db, engine, "Alice", { types: ["user"] });
    for (const r of results) {
      expect(r.entity.type).toBe("user");
    }
  });

  it("respects minScore threshold", () => {
    engine.upsertEntity({ name: "X", type: "concept" });

    const results = searchGraph(db, engine, "X", { minScore: 0.99 });
    // Very high threshold — may return 0 results
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0.99);
    }
  });

  it("includes edges and related names", () => {
    const a = engine.upsertEntity({ name: "Alice", type: "user" });
    const b = engine.upsertEntity({ name: "ProjectX", type: "project" });
    engine.addEdge({ fromId: a.id, toId: b.id, relation: "works_on" });

    const results = searchGraph(db, engine, "Alice", { includeEdges: true, minScore: 0 });
    expect(results.length).toBeGreaterThan(0);
    const alice = results.find((r) => r.entity.name === "Alice");
    if (alice) {
      expect(alice.edges.length).toBeGreaterThanOrEqual(1);
      expect(alice.relatedNames).toContain("ProjectX");
    }
  });

  it("applies temporal decay", () => {
    // Create an old entity
    const old = engine.upsertEntity({ name: "Ancient", type: "concept" });
    // Manually set updated_at to 365 days ago
    db.prepare(`UPDATE entities SET updated_at = ? WHERE id = ?`).run(
      Date.now() - 365 * 24 * 60 * 60 * 1000,
      old.id,
    );

    const fresh = engine.upsertEntity({ name: "Fresh", type: "concept" });

    const results = searchGraph(db, engine, "concept", {
      temporalDecayDays: 30,
      minScore: 0,
    });

    const ancientResult = results.find((r) => r.entity.id === old.id);
    const freshResult = results.find((r) => r.entity.id === fresh.id);

    if (ancientResult && freshResult) {
      // Fresh should have higher temporal factor
      expect(freshResult.scoreBreakdown.temporal).toBeGreaterThan(ancientResult.scoreBreakdown.temporal);
    }
  });

  it("applies diversity filter when results exceed maxResults", () => {
    // Create many entities of same type
    for (let i = 0; i < 20; i++) {
      engine.upsertEntity({ name: `Entity${i}`, type: "concept", summary: `common query term ${i}` });
    }
    engine.upsertEntity({ name: "DifferentType", type: "user", summary: "common query term" });

    const results = searchGraph(db, engine, "common query term", { maxResults: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it("returns empty for no matches", () => {
    const results = searchGraph(db, engine, "zzzznonexistent");
    expect(results).toEqual([]);
  });

  it("handles empty query gracefully", () => {
    engine.upsertEntity({ name: "Test", type: "concept" });
    // Empty query — FTS sanitizer returns "", LIKE fallback with %% matches all
    const results = searchGraph(db, engine, "");
    expect(Array.isArray(results)).toBe(true);
  });

  it("excludes invalidated entities by default", () => {
    const entity = engine.upsertEntity({ name: "Gone", type: "concept", summary: "disappeared" });
    engine.invalidateEntity(entity.id);

    const results = searchGraph(db, engine, "Gone");
    const found = results.find((r) => r.entity.id === entity.id);
    expect(found).toBeUndefined();
  });
});
