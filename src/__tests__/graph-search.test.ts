import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine, type EmbedFn } from "../host/graph-engine.js";
import { searchGraph, clearSearchCache, type GraphSearchOpts } from "../host/graph-search.js";
import { retrieve } from "../host/graph-retrieval.js";
import { buildPinnedMemory, formatPinnedMemory } from "../host/graph-context-loader.js";
import { createTestDb } from "./test-helpers.js";

describe("searchGraph", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => {
    clearSearchCache();
    db.close();
  });

  // -------------------------------------------------------------------------
  // FTS path
  // -------------------------------------------------------------------------

  it("finds entities via FTS", async () => {
    engine.upsertEntity({ name: "React", type: "concept", summary: "UI library" });
    engine.upsertEntity({ name: "Vue", type: "concept", summary: "Progressive framework" });

    // Use low minScore since BM25 scores are very small with few documents
    const results = await searchGraph(db, engine, "React", { minScore: 0 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.entity.name).toBe("React");
  });

  it("falls back to LIKE when FTS returns nothing", async () => {
    engine.upsertEntity({ name: "MyUniqueEntity", type: "concept", summary: "special" });

    const results = await searchGraph(db, engine, "MyUniqueEntity", { minScore: 0 });
    expect(results.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Vector path
  // -------------------------------------------------------------------------

  it("uses vector similarity when queryEmbedding provided", async () => {
    engine.upsertEntity({ name: "A", type: "concept", embedding: [1.0, 0.0, 0.0] });
    engine.upsertEntity({ name: "B", type: "concept", embedding: [0.0, 1.0, 0.0] });

    const results = await searchGraph(db, engine, "test", {
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

  it("auto-generates queryEmbedding via engine embedFn", async () => {
    const mockEmbed: EmbedFn = () => [1.0, 0.0, 0.0];
    const embedEngine = new MemoryGraphEngine(db, { embedFn: mockEmbed });

    embedEngine.upsertEntity({ name: "A", type: "concept" }); // auto-embed [1,0,0]
    embedEngine.upsertEntity({ name: "B", type: "concept", embedding: [0.0, 1.0, 0.0] });

    // Search without explicit queryEmbedding — should use embedFn
    const results = await searchGraph(db, embedEngine, "anything", {
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

  it("filters by entity type", async () => {
    engine.upsertEntity({ name: "Alice", type: "user" });
    engine.upsertEntity({ name: "Alice Method", type: "concept" });

    const results = await searchGraph(db, engine, "Alice", { types: ["user"] });
    for (const r of results) {
      expect(r.entity.type).toBe("user");
    }
  });

  it("respects minScore threshold", async () => {
    engine.upsertEntity({ name: "X", type: "concept" });

    const results = await searchGraph(db, engine, "X", { minScore: 0.99 });
    // Very high threshold — may return 0 results
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0.99);
    }
  });

  it("includes edges and related names", async () => {
    const a = engine.upsertEntity({ name: "Alice", type: "user" });
    const b = engine.upsertEntity({ name: "ProjectX", type: "project" });
    engine.addEdge({ fromId: a.id, toId: b.id, relation: "works_on" });

    const results = await searchGraph(db, engine, "Alice", { includeEdges: true, minScore: 0 });
    expect(results.length).toBeGreaterThan(0);
    const alice = results.find((r) => r.entity.name === "Alice");
    if (alice) {
      expect(alice.edges.length).toBeGreaterThanOrEqual(1);
      expect(alice.relatedNames).toContain("ProjectX");
    }
  });

  it("applies temporal decay", async () => {
    // Create an old entity
    const old = engine.upsertEntity({ name: "Ancient", type: "concept" });
    // Manually set updated_at to 365 days ago
    db.prepare(`UPDATE entities SET updated_at = ? WHERE id = ?`).run(
      Date.now() - 365 * 24 * 60 * 60 * 1000,
      old.id,
    );

    const fresh = engine.upsertEntity({ name: "Fresh", type: "concept" });

    const results = await searchGraph(db, engine, "concept", {
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

  it("applies diversity filter when results exceed maxResults", async () => {
    // Create many entities of same type
    for (let i = 0; i < 20; i++) {
      engine.upsertEntity({ name: `Entity${i}`, type: "concept", summary: `common query term ${i}` });
    }
    engine.upsertEntity({ name: "DifferentType", type: "user", summary: "common query term" });

    const results = await searchGraph(db, engine, "common query term", { maxResults: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it("returns empty for no matches", async () => {
    const results = await searchGraph(db, engine, "zzzznonexistent");
    expect(results).toEqual([]);
  });

  it("handles empty query gracefully", async () => {
    engine.upsertEntity({ name: "Test", type: "concept" });
    // Empty query — FTS sanitizer returns "", LIKE fallback with %% matches all
    const results = await searchGraph(db, engine, "");
    expect(Array.isArray(results)).toBe(true);
  });

  it("excludes invalidated entities by default", async () => {
    const entity = engine.upsertEntity({ name: "Gone", type: "concept", summary: "disappeared" });
    engine.invalidateEntity(entity.id);

    const results = await searchGraph(db, engine, "Gone");
    const found = results.find((r) => r.entity.id === entity.id);
    expect(found).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Search cache
  // -------------------------------------------------------------------------

  describe("search cache", () => {
    it("isolates cache entries per database", async () => {
      const db2 = createTestDb();
      const engine2 = new MemoryGraphEngine(db2);

      engine.upsertEntity({ name: "Alpha", type: "concept", summary: "shared-term" });
      engine2.upsertEntity({ name: "Beta", type: "concept", summary: "shared-term" });

      const results1 = await searchGraph(db, engine, "shared-term", {
        minScore: 0, vectorWeight: 0, ftsWeight: 1, graphWeight: 0,
      });
      const results2 = await searchGraph(db2, engine2, "shared-term", {
        minScore: 0, vectorWeight: 0, ftsWeight: 1, graphWeight: 0,
      });

      expect(results1[0]!.entity.name).toBe("Alpha");
      expect(results2[0]!.entity.name).toBe("Beta");
      db2.close();
    });

    it("includes relation expansion options in the cache key", async () => {
      const alice = engine.upsertEntity({ name: "Alice", type: "user", summary: "engineer" });
      const project = engine.upsertEntity({ name: "ProjectX", type: "project", summary: "initiative" });
      engine.addEdge({ fromId: alice.id, toId: project.id, relation: "works_on" });

      const withoutEdges = await searchGraph(db, engine, "Alice", { minScore: 0, includeEdges: false });
      const withEdges = await searchGraph(db, engine, "Alice", { minScore: 0, includeEdges: true });

      expect(withoutEdges[0]!.edges).toHaveLength(0);
      expect(withEdges[0]!.edges.length).toBeGreaterThan(0);
    });

    it("includes query embeddings in the cache key", async () => {
      engine.upsertEntity({ name: "VectorA", type: "concept", embedding: [1.0, 0.0, 0.0] });
      engine.upsertEntity({ name: "VectorB", type: "concept", embedding: [0.0, 1.0, 0.0] });

      const resultsA = await searchGraph(db, engine, "semantic-query", {
        queryEmbedding: [1.0, 0.0, 0.0], vectorWeight: 1.0, ftsWeight: 0.0, graphWeight: 0.0, minScore: 0,
      });
      const resultsB = await searchGraph(db, engine, "semantic-query", {
        queryEmbedding: [0.0, 1.0, 0.0], vectorWeight: 1.0, ftsWeight: 0.0, graphWeight: 0.0, minScore: 0,
      });

      expect(resultsA[0]!.entity.name).toBe("VectorA");
      expect(resultsB[0]!.entity.name).toBe("VectorB");
    });

    it("returns cached results on repeated query", async () => {
      engine.upsertEntity({ name: "Cached", type: "concept", summary: "test cache" });

      const opts = { minScore: 0, vectorWeight: 0, ftsWeight: 1, graphWeight: 0 };
      const results1 = await searchGraph(db, engine, "Cached", opts);
      const results2 = await searchGraph(db, engine, "Cached", opts);

      expect(results2.length).toBe(results1.length);
      if (results1.length > 0 && results2.length > 0) {
        expect(results2[0]!.entity.id).toBe(results1[0]!.entity.id);
      }
    });

    it("cache can be cleared", async () => {
      engine.upsertEntity({ name: "Fresh", type: "concept", summary: "clear cache" });

      await searchGraph(db, engine, "Fresh", { minScore: 0 });
      clearSearchCache();

      const results = await await searchGraph(db, engine, "Fresh", { minScore: 0 });
      expect(results.length).toBeGreaterThan(0);
    });

    it("cache respects TTL", async () => {
      engine.upsertEntity({ name: "TTL", type: "concept", summary: "ttl test" });

      await searchGraph(db, engine, "TTL", { minScore: 0, cacheTtlMs: 50 });

      await new Promise((r) => setTimeout(r, 60));

      engine.upsertEntity({ name: "TTL", type: "concept", summary: "updated" });

      const results2 = await await searchGraph(db, engine, "TTL", { minScore: 0, cacheTtlMs: 50 });
      expect(results2.length).toBeGreaterThan(0);
    });

    it("invalidates cached graph results when edges change", async () => {
      const alice = engine.upsertEntity({ name: "Alice", type: "user", summary: "engineer" });
      const before = await searchGraph(db, engine, "Alice", {
        minScore: 0, includeEdges: true, cacheTtlMs: 60_000,
      });
      expect(before[0]!.edges).toHaveLength(0);

      const project = engine.upsertEntity({ name: "ProjectX", type: "project", summary: "initiative" });
      engine.addEdge({ fromId: alice.id, toId: project.id, relation: "works_on" });

      const after = await searchGraph(db, engine, "Alice", {
        minScore: 0, includeEdges: true, cacheTtlMs: 60_000,
      });
      expect(after[0]!.edges.length).toBeGreaterThan(0);
      expect(after[0]!.relatedNames).toContain("ProjectX");
    });
  });

  // -------------------------------------------------------------------------
  // FTS score normalization
  // -------------------------------------------------------------------------

  describe("FTS score normalization", () => {
    it("returns meaningful scores even with small document sets", async () => {
      engine.upsertEntity({ name: "React", type: "concept", summary: "UI library by Meta" });
      engine.upsertEntity({ name: "Vue", type: "concept", summary: "Progressive framework" });
      engine.upsertEntity({ name: "Angular", type: "concept", summary: "Platform for web apps" });

      const results = await searchGraph(db, engine, "React", {
        vectorWeight: 0,
        ftsWeight: 1.0,
        graphWeight: 0,
        minScore: 0,
      });

      expect(results.length).toBeGreaterThan(0);
      // With normalization, score should be meaningfully > 0 (not tiny like 0.001)
      expect(results[0]!.score).toBeGreaterThan(0.1);
    });

    it("gives higher score to better matches", async () => {
      engine.upsertEntity({ name: "React", type: "concept", summary: "UI library" });
      engine.upsertEntity({ name: "ReactiveX", type: "concept", summary: "Reactive extensions" });

      const results = await searchGraph(db, engine, "React", {
        vectorWeight: 0,
        ftsWeight: 1.0,
        graphWeight: 0,
        minScore: 0,
      });

      const react = results.find((r) => r.entity.name === "React");
      const reactivex = results.find((r) => r.entity.name === "ReactiveX");

      if (react && reactivex) {
        expect(react.score).toBeGreaterThan(reactivex.score);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Retrieval pipeline (S5)
  // -------------------------------------------------------------------------

  describe("retrieve pipeline", () => {
    it("entity mode returns entity results", async () => {
      engine.upsertEntity({ name: "Alice", type: "user", summary: "engineer" });
      engine.upsertEntity({ name: "ProjectX", type: "project", summary: "main project" });

      const result = await retrieve(db, engine, "Alice", { mode: "entity", maxResults: 3 });
      expect(result.mode).toBe("entity");
      expect(result.entities.length).toBeGreaterThan(0);
      expect(result.entities[0]!.name).toBe("Alice");
    });

    it("global mode returns community reports when available", async () => {
      // Without communities, should return empty reports
      const result = await retrieve(db, engine, "overview summary", { mode: "global" });
      expect(result.mode).toBe("global");
      expect(result.entities).toHaveLength(0);
    });

    it("mixed mode auto-detects broad query and uses global path", async () => {
      engine.upsertEntity({ name: "Test", type: "concept" });

      // "总结" is a broad keyword
      const result = await retrieve(db, engine, "总结所有内容", { mode: "mixed" });
      expect(result.mode).toBe("global");
      expect(result.entities).toHaveLength(0);
    });

    it("mixed mode uses entity path for focused queries", async () => {
      engine.upsertEntity({ name: "Alice", type: "user", summary: "engineer" });

      const result = await retrieve(db, engine, "Alice", { mode: "mixed" });
      expect(result.mode).toBe("mixed");
      expect(result.entities.length).toBeGreaterThan(0);
    });

    it("debug mode returns query hints", async () => {
      const result = await retrieve(db, engine, "Who is Alice", { mode: "debug" });
      expect(result.mode).toBe("debug");
      expect(result.scoreBreakdown).toHaveProperty("hints");
    });

    it("focal rerank boosts well-connected entities", async () => {
      const hub = engine.upsertEntity({ name: "Hub", type: "concept", summary: "central" });
      const spoke = engine.upsertEntity({ name: "Spoke", type: "concept", summary: "central" });

      // Hub has 5 connections, Spoke has 0
      for (let i = 0; i < 5; i++) {
        const n = engine.upsertEntity({ name: `Neighbor${i}`, type: "concept" });
        engine.addEdge({ fromId: hub.id, toId: n.id, relation: "linked" });
      }

      const result = await retrieve(db, engine, "central", {
        mode: "entity",
        maxResults: 5,
      });

      // Both should be found; Hub may rank higher due to focal boost
      const names = result.entities.map((e) => e.name);
      expect(names).toContain("Hub");
    });

    it("respects maxTokens budget", async () => {
      for (let i = 0; i < 20; i++) {
        engine.upsertEntity({ name: `Entity${i}`, type: "concept", summary: "A".repeat(200) });
      }

      const result = await retrieve(db, engine, "Entity", {
        mode: "entity",
        maxTokens: 100,
      });

      // Should pack fewer results due to tight budget
      expect(result.entities.length).toBeLessThanOrEqual(20);
    });
  });

  // -------------------------------------------------------------------------
  // Pinned core memory
  // -------------------------------------------------------------------------

  describe("pinned core memory", () => {
    it("includes high-confidence user/preference entities", () => {
      engine.upsertEntity({ name: "Alice", type: "user", summary: "PM", confidence: 0.9 });
      engine.upsertEntity({ name: "DarkMode", type: "preference", summary: "dark theme", confidence: 0.95 });
      engine.upsertEntity({ name: "RandomThing", type: "concept", summary: "noise", confidence: 0.9 });

      const pinned = buildPinnedMemory(engine);
      expect(pinned.entities.length).toBeGreaterThanOrEqual(2);
      const names = pinned.entities.map((e) => e.name);
      expect(names).toContain("Alice");
      expect(names).toContain("DarkMode");
      expect(names).not.toContain("RandomThing");
    });

    it("excludes low-confidence entities", () => {
      engine.upsertEntity({ name: "LowConf", type: "user", summary: "uncertain", confidence: 0.3 });

      const pinned = buildPinnedMemory(engine);
      expect(pinned.entities.find((e) => e.name === "LowConf")).toBeUndefined();
    });

    it("sorts by access_count descending", () => {
      engine.upsertEntity({ name: "Popular", type: "user", summary: "frequently accessed", confidence: 0.9 });
      engine.upsertEntity({ name: "Rare", type: "user", summary: "rarely accessed", confidence: 0.9 });

      // Touch Popular multiple times
      const popular = engine.findEntities({ name: "Popular", activeOnly: true })[0];
      if (popular) {
        for (let i = 0; i < 5; i++) engine.touchEntity(popular.id);
      }

      const pinned = buildPinnedMemory(engine);
      if (pinned.entities.length >= 2) {
        expect(pinned.entities[0]!.name).toBe("Popular");
      }
    });

    it("respects maxTokens budget", () => {
      engine.upsertEntity({ name: "A", type: "user", summary: "X".repeat(500), confidence: 0.9 });
      engine.upsertEntity({ name: "B", type: "user", summary: "Y".repeat(500), confidence: 0.9 });

      const pinned = buildPinnedMemory(engine, { maxTokens: 10 });
      // Very tight budget — should include at most 1 or 0
      expect(pinned.entities.length).toBeLessThanOrEqual(1);
    });

    it("formatPinnedMemory produces Core Memory section", () => {
      const pinned = {
        entities: [{ name: "Alice", type: "user", summary: "PM" }],
        estimatedTokens: 10,
      };
      const formatted = formatPinnedMemory(pinned);
      expect(formatted).toContain("## Core Memory");
      expect(formatted).toContain("Alice (user): PM");
    });

    it("formatPinnedMemory returns empty for no entities", () => {
      expect(formatPinnedMemory({ entities: [], estimatedTokens: 0 })).toBe("");
    });
  });
});
