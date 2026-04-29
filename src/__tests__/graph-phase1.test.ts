import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryGraphEngine,
  serializeEmbedding,
  deserializeEmbedding,
  normalizeEntityName,
  type EmbedFn,
} from "../host/graph-engine.js";
import { ensureGraphSchema, sanitizeFtsQuery, searchEntityFts } from "../host/graph-schema.js";
import { searchGraph } from "../host/graph-search.js";
import { createTestDb } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// 1.1 Edge Dedup
// ---------------------------------------------------------------------------

describe("Edge dedup", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  it("returns existing edge instead of creating duplicate", () => {
    const a = engine.upsertEntity({ name: "A", type: "concept" });
    const b = engine.upsertEntity({ name: "B", type: "concept" });

    const edge1 = engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates_to" });
    const edge2 = engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates_to" });

    // Same edge returned
    expect(edge2.id).toBe(edge1.id);

    // Only 1 edge in DB
    const allEdges = engine.findEdges({ entityId: a.id });
    expect(allEdges).toHaveLength(1);
  });

  it("updates weight to max on dedup", () => {
    const a = engine.upsertEntity({ name: "A", type: "concept" });
    const b = engine.upsertEntity({ name: "B", type: "concept" });

    engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates_to", weight: 0.5 });
    const edge2 = engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates_to", weight: 0.9 });

    expect(edge2.weight).toBe(0.9);
  });

  it("creates separate edges for different relations", () => {
    const a = engine.upsertEntity({ name: "A", type: "concept" });
    const b = engine.upsertEntity({ name: "B", type: "concept" });

    engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates_to" });
    engine.addEdge({ fromId: a.id, toId: b.id, relation: "depends_on" });

    const allEdges = engine.findEdges({ entityId: a.id });
    expect(allEdges).toHaveLength(2);
  });

  it("creates separate edges for different directions", () => {
    const a = engine.upsertEntity({ name: "A", type: "concept" });
    const b = engine.upsertEntity({ name: "B", type: "concept" });

    engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates_to" });
    engine.addEdge({ fromId: b.id, toId: a.id, relation: "relates_to" });

    const allEdges = engine.findEdges({ entityId: a.id });
    expect(allEdges).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 1.2 Embedding Binary Storage
// ---------------------------------------------------------------------------

describe("Embedding BLOB storage", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  it("serializes and deserializes embeddings correctly", () => {
    const vec = [0.1, 0.2, 0.3, -0.5, 1.0];
    const blob = serializeEmbedding(vec);
    const restored = deserializeEmbedding(blob);

    expect(restored).toHaveLength(vec.length);
    for (let i = 0; i < vec.length; i++) {
      expect(restored[i]).toBeCloseTo(vec[i]!, 5);
    }
  });

  it("stores and retrieves embeddings via engine", () => {
    const vec = [0.1, 0.2, 0.3, 0.4, 0.5];
    const entity = engine.upsertEntity({
      name: "Test",
      type: "concept",
      embedding: vec,
    });

    const retrieved = engine.getEntity(entity.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.embeddingVector).toBeDefined();
    expect(retrieved!.embeddingVector).toHaveLength(5);
    expect(retrieved!.embeddingVector![0]).toBeCloseTo(0.1, 5);
  });

  it("stores embedding as BLOB (not TEXT)", () => {
    engine.upsertEntity({
      name: "BlobTest",
      type: "concept",
      embedding: [1.0, 2.0, 3.0],
    });

    const row = db
      .prepare(`SELECT typeof(embedding) as t FROM entities WHERE name = 'BlobTest'`)
      .get() as { t: string };
    expect(row.t).toBe("blob");
  });

  it("migrates TEXT embeddings to BLOB on schema init", () => {
    // Create a fresh DB and manually insert a TEXT embedding
    const db2 = new DatabaseSync(":memory:");
    db2.exec(`
      CREATE TABLE entities (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
        summary TEXT, embedding TEXT, confidence REAL NOT NULL DEFAULT 1.0,
        source TEXT NOT NULL DEFAULT 'auto', valid_from INTEGER NOT NULL,
        valid_until INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    const now = Date.now();
    db2.prepare(
      `INSERT INTO entities (id, name, type, embedding, confidence, source, valid_from, created_at, updated_at)
       VALUES ('id1', 'MigTest', 'concept', ?, 1.0, 'auto', ?, ?, ?)`,
    ).run(JSON.stringify([0.1, 0.2, 0.3]), now, now, now);

    // Run schema migration
    ensureGraphSchema({ db: db2, ftsEnabled: true });

    // Verify it's now BLOB
    const row = db2.prepare(`SELECT typeof(embedding) as t FROM entities WHERE id = 'id1'`).get() as { t: string };
    expect(row.t).toBe("blob");

    // Verify data integrity
    const engine2 = new MemoryGraphEngine(db2);
    const entity = engine2.getEntity("id1");
    expect(entity!.embeddingVector).toHaveLength(3);
    expect(entity!.embeddingVector![0]).toBeCloseTo(0.1, 5);

    db2.close();
  });
});

// ---------------------------------------------------------------------------
// 1.3 FTS Query Safety
// ---------------------------------------------------------------------------

describe("FTS query safety", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
    engine.upsertEntity({ name: "React Framework", type: "concept", summary: "A JavaScript UI library" });
    engine.upsertEntity({ name: "Vue.js", type: "concept", summary: "Progressive framework" });
  });
  afterEach(() => db.close());

  it("sanitizes FTS operators from query", () => {
    expect(sanitizeFtsQuery('"hello" world')).toBe('"hello" "world"');
    expect(sanitizeFtsQuery("foo*bar")).toBe('"foo" "bar"');
    expect(sanitizeFtsQuery("(test)")).toBe('"test"');
    expect(sanitizeFtsQuery("a:b^c~d")).toBe('"a" "b" "c" "d"');
  });

  it("returns empty string for all-operator input", () => {
    expect(sanitizeFtsQuery('"*(){}^~:')).toBe("");
  });

  it("does not crash on special characters in search", () => {
    const result1 = searchEntityFts(db, '"React"');
    expect(Array.isArray(result1)).toBe(true);

    const result2 = searchEntityFts(db, "React* OR Vue(");
    expect(Array.isArray(result2)).toBe(true);

    const result3 = searchEntityFts(db, "***");
    expect(result3).toEqual([]);
  });

  it("still returns correct results after sanitization", () => {
    const results = searchEntityFts(db, "React");
    expect(results.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 1.4 EmbedFn Hook
// ---------------------------------------------------------------------------

describe("EmbedFn hook", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it("auto-generates embeddings on upsert when embedFn is set", () => {
    const mockEmbed: EmbedFn = (text: string) => {
      // Simple deterministic "embedding" based on text length
      return [text.length / 100, 0.5, 0.3];
    };

    const engine = new MemoryGraphEngine(db, { embedFn: mockEmbed });
    const entity = engine.upsertEntity({ name: "TestEntity", type: "concept", summary: "A test" });

    const retrieved = engine.getEntity(entity.id);
    expect(retrieved!.embeddingVector).toBeDefined();
    expect(retrieved!.embeddingVector).toHaveLength(3);
    // "TestEntity A test" = 17 chars → 0.17
    expect(retrieved!.embeddingVector![0]).toBeCloseTo(0.17, 2);
  });

  it("does not override explicit embedding", () => {
    const mockEmbed: EmbedFn = () => [9.9, 9.9, 9.9];

    const engine = new MemoryGraphEngine(db, { embedFn: mockEmbed });
    const entity = engine.upsertEntity({
      name: "TestEntity",
      type: "concept",
      embedding: [0.1, 0.2, 0.3],
    });

    const retrieved = engine.getEntity(entity.id);
    expect(retrieved!.embeddingVector![0]).toBeCloseTo(0.1, 5);
  });

  it("getEmbedFn returns the configured function", () => {
    const fn: EmbedFn = () => [1, 2, 3];
    const engine = new MemoryGraphEngine(db, { embedFn: fn });
    expect(engine.getEmbedFn()).toBe(fn);
  });

  it("getEmbedFn returns undefined when not configured", () => {
    const engine = new MemoryGraphEngine(db);
    expect(engine.getEmbedFn()).toBeUndefined();
  });

  it("auto-generates query embedding in searchGraph", async () => {
    const mockEmbed: EmbedFn = (text: string) => {
      // Simple embedding: normalize first 3 char codes
      const codes = [0, 0, 0];
      for (let i = 0; i < Math.min(3, text.length); i++) {
        codes[i] = text.charCodeAt(i) / 255;
      }
      return codes;
    };

    const engine = new MemoryGraphEngine(db, { embedFn: mockEmbed });

    // Create entities (embedFn will auto-generate embeddings)
    engine.upsertEntity({ name: "Alpha", type: "concept", summary: "First item" });
    engine.upsertEntity({ name: "Beta", type: "concept", summary: "Second item" });

    // Search without explicit queryEmbedding — should use embedFn
    const results = await searchGraph(db, engine, "Alpha");
    // Should return results (FTS + vector combined)
    expect(results.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 1.5 Entity Name Normalization
// ---------------------------------------------------------------------------

describe("Entity name normalization", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  it("normalizeEntityName trims and lowercases", () => {
    expect(normalizeEntityName("  React  ")).toBe("react");
    expect(normalizeEntityName("My  Project")).toBe("my project");
    expect(normalizeEntityName("UPPER")).toBe("upper");
  });

  it("upsert with different case merges into same entity", () => {
    const e1 = engine.upsertEntity({ name: "React", type: "concept", summary: "v1" });
    const e2 = engine.upsertEntity({ name: "react", type: "concept", summary: "v2" });

    // Should be the same entity (not new)
    expect(e2.isNew).toBe(false);
    expect(e2.id).toBe(e1.id);
    expect(e2.summary).toBe("v2");
  });

  it("findEntities resolves via alias", () => {
    engine.upsertEntity({ name: "React", type: "concept" });

    // Search by different case
    const results = engine.findEntities({ name: "react", type: "concept" });
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("React");
  });

  it("addAlias creates custom alias", () => {
    const entity = engine.upsertEntity({ name: "React", type: "concept" });
    engine.addAlias(entity.id, "ReactJS");

    // Find via alias
    const results = engine.findEntities({ name: "reactjs", type: "concept" });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(entity.id);
  });

  it("aliases do not cross entity types", () => {
    engine.upsertEntity({ name: "React", type: "concept" });
    engine.upsertEntity({ name: "React", type: "tool" });

    // Search for "react" as concept
    const concepts = engine.findEntities({ name: "react", type: "concept" });
    expect(concepts).toHaveLength(1);
    expect(concepts[0]!.type).toBe("concept");

    // Search for "react" as tool
    const tools = engine.findEntities({ name: "react", type: "tool" });
    expect(tools).toHaveLength(1);
    expect(tools[0]!.type).toBe("tool");
  });
});

// ---------------------------------------------------------------------------
// Vector search (previously 0 test coverage)
// ---------------------------------------------------------------------------

describe("Vector search path", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  it("ranks entities by cosine similarity", async () => {
    // Create entities with known embeddings
    engine.upsertEntity({
      name: "Close",
      type: "concept",
      embedding: [1.0, 0.0, 0.0],
    });
    engine.upsertEntity({
      name: "Far",
      type: "concept",
      embedding: [0.0, 1.0, 0.0],
    });
    engine.upsertEntity({
      name: "Medium",
      type: "concept",
      embedding: [0.7, 0.7, 0.0],
    });

    // Query embedding close to "Close"
    const results = await searchGraph(db, engine, "test", {
      queryEmbedding: [1.0, 0.0, 0.0],
      vectorWeight: 1.0,
      ftsWeight: 0.0,
      graphWeight: 0.0,
      minScore: 0,
    });

    expect(results.length).toBeGreaterThanOrEqual(2);
    // "Close" should rank highest (cosine sim = 1.0)
    expect(results[0]!.entity.name).toBe("Close");
    expect(results[0]!.scoreBreakdown.vector).toBeCloseTo(1.0, 2);
  });

  it("handles empty embedding gracefully", async () => {
    engine.upsertEntity({ name: "NoEmbed", type: "concept" });

    const results = await searchGraph(db, engine, "test", {
      queryEmbedding: [1.0, 0.0],
    });
    // Should not crash, may return 0 or more results
    expect(Array.isArray(results)).toBe(true);
  });
});
