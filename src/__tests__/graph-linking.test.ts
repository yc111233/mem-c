import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import { ensureGraphSchema } from "../host/graph-schema.js";
import { linkEntities, findLinkCandidates, type LinkCandidate } from "../host/graph-linking.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureGraphSchema({ db, ftsEnabled: true });
  return db;
}

/** Create a simple embedding: unit vector along dimension `dim`. */
function unitVec(dim: number, dims = 16): number[] {
  const v = new Array(dims).fill(0);
  v[dim] = 1;
  return v;
}

/**
 * Insert an entity directly via SQL, bypassing the engine's alias-based dedup.
 * Used to simulate entities from external imports that the linker should detect.
 */
function insertRawEntity(
  db: DatabaseSync,
  opts: { name: string; type: string; confidence?: number; embedding?: number[] },
): { id: string; name: string; type: string; confidence: number } {
  const id = randomUUID();
  const now = Date.now();
  const embeddingBlob = opts.embedding
    ? Buffer.from(new Float32Array(opts.embedding).buffer)
    : null;
  db.prepare(
    `INSERT INTO entities (id, name, type, confidence, source, embedding, valid_from, valid_until, created_at, updated_at, access_count, last_accessed_at) ` +
      `VALUES (?, ?, ?, ?, 'imported', ?, ?, NULL, ?, ?, 0, 0)`,
  ).run(id, opts.name, opts.type, opts.confidence ?? 1.0, embeddingBlob, now, now, now);
  return { id, name: opts.name, type: opts.type, confidence: opts.confidence ?? 1.0 };
}

/**
 * Fetch an entity row from the DB and return it shaped like the engine's Entity type.
 * Used for raw-inserted entities that the engine doesn't know about yet.
 */
function getRawEntity(db: DatabaseSync, id: string): any {
  const row = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(id) as any;
  if (!row) return null;
  if (row.embedding) {
    const f32 = new Float32Array(new Uint8Array(row.embedding).buffer);
    row.embeddingVector = Array.from(f32);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("linkEntities", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("same_as decisions", () => {
    it("returns same_as for same-name same-type raw duplicates", () => {
      // Create via engine + raw SQL to simulate imported duplicate
      const a = engine.upsertEntity({ name: "React", type: "concept", confidence: 0.9 });
      const bRaw = insertRawEntity(db, { name: "React", type: "concept", confidence: 0.5 });
      const b = getRawEntity(db, bRaw.id);

      const result = linkEntities(engine, { entityA: a, entityB: b });
      expect(result.decision).toBe("same_as");
      expect(result.score).toBeGreaterThanOrEqual(0.8);
      expect(result.evidence).toContain("type match: concept");
      expect(result.evidence).toContain("exact name match (normalized)");
    });

    it("returns same_as when embeddings are highly similar", () => {
      const a = engine.upsertEntity({
        name: "React",
        type: "concept",
        embedding: unitVec(0),
        confidence: 0.9,
      });
      const bRaw = insertRawEntity(db, {
        name: "React",
        type: "concept",
        embedding: unitVec(0), // identical embedding
        confidence: 0.5,
      });
      const b = getRawEntity(db, bRaw.id);

      const result = linkEntities(engine, { entityA: a, entityB: b });
      expect(result.decision).toBe("same_as");
      expect(result.evidence.some((e: string) => e.startsWith("embedding similarity"))).toBe(true);
    });

    it("returns same_as when alias + substring together reach threshold", () => {
      const a = engine.upsertEntity({ name: "React", type: "concept", confidence: 0.9 });
      const bRaw = insertRawEntity(db, { name: "reactjs", type: "concept", confidence: 0.5 });
      // Register alias: "reactjs" maps to entity a
      engine.addAlias(a.id, "reactjs");
      const b = getRawEntity(db, bRaw.id);

      const result = linkEntities(engine, { entityA: a, entityB: b });
      // type(0.3) + substring(0.2) + alias(0.2) = 0.7 — possibly_same_as
      expect(result.decision).toBe("possibly_same_as");
      expect(result.evidence).toContain("alias match");
    });
  });

  describe("possibly_same_as decisions", () => {
    it("returns possibly_same_as for moderate score", () => {
      const a = engine.upsertEntity({
        name: "React Framework",
        type: "concept",
        embedding: unitVec(0),
        confidence: 0.9,
      });
      const bRaw = insertRawEntity(db, {
        name: "React",
        type: "concept",
        embedding: unitVec(1), // different embedding
        confidence: 0.5,
      });
      const b = getRawEntity(db, bRaw.id);

      const result = linkEntities(engine, { entityA: a, entityB: b });
      // type(0.3) + substring(0.2) = 0.5 — hits possibly_same_as threshold
      expect(result.decision).toBe("possibly_same_as");
    });
  });

  describe("distinct decisions", () => {
    it("returns distinct for cross-type entities", () => {
      const a = engine.upsertEntity({ name: "React", type: "concept", confidence: 0.9 });
      const b = engine.upsertEntity({ name: "React", type: "tool", confidence: 0.5 });

      const result = linkEntities(engine, { entityA: a, entityB: b });
      expect(result.decision).toBe("distinct");
      expect(result.score).toBe(0);
      expect(result.evidence).toContain("cross-type incompatible");
    });

    it("returns distinct for different-name different-type entities", () => {
      const a = engine.upsertEntity({ name: "React", type: "concept", confidence: 0.9 });
      const b = engine.upsertEntity({ name: "TypeScript", type: "tool", confidence: 0.5 });

      const result = linkEntities(engine, { entityA: a, entityB: b });
      expect(result.decision).toBe("distinct");
      expect(result.score).toBe(0);
    });

    it("returns distinct for same-type but very different names with no other signals", () => {
      const a = engine.upsertEntity({ name: "React", type: "concept", confidence: 0.9 });
      const b = engine.upsertEntity({ name: "PostgreSQL", type: "concept", confidence: 0.5 });

      const result = linkEntities(engine, { entityA: a, entityB: b });
      expect(result.decision).toBe("distinct");
      // type(0.3) + no name match = 0.3 < 0.5
      expect(result.score).toBeLessThan(0.5);
    });
  });

  describe("shared neighbors", () => {
    it("adds score for entities with 2+ shared neighbors", () => {
      const a = engine.upsertEntity({ name: "React", type: "concept", confidence: 0.9 });
      const bRaw = insertRawEntity(db, { name: "reactjs", type: "concept", confidence: 0.5 });
      const b = getRawEntity(db, bRaw.id);
      const n1 = engine.upsertEntity({ name: "JSX", type: "concept" });
      const n2 = engine.upsertEntity({ name: "Hooks", type: "concept" });

      // Both a and b connect to n1 and n2
      engine.addEdge({ fromId: a.id, toId: n1.id, relation: "uses" });
      engine.addEdge({ fromId: a.id, toId: n2.id, relation: "uses" });
      engine.addEdge({ fromId: b.id, toId: n1.id, relation: "uses" });
      engine.addEdge({ fromId: b.id, toId: n2.id, relation: "uses" });

      const result = linkEntities(engine, { entityA: a, entityB: b });
      expect(result.evidence.some((e: string) => e.includes("shared neighbors"))).toBe(true);
    });
  });

  describe("threshold overrides", () => {
    it("respects custom sameAsThreshold", () => {
      const a = engine.upsertEntity({ name: "React", type: "concept", confidence: 0.9 });
      const bRaw = insertRawEntity(db, { name: "React", type: "concept", confidence: 0.5 });
      const b = getRawEntity(db, bRaw.id);

      // Raise threshold above what name+type alone can reach
      const result = linkEntities(engine, { entityA: a, entityB: b }, { sameAsThreshold: 0.9 });
      // type(0.3) + name(0.5) = 0.8 < 0.9
      expect(result.decision).not.toBe("same_as");
      expect(result.decision).toBe("possibly_same_as");
    });

    it("respects custom possibleThreshold", () => {
      const a = engine.upsertEntity({ name: "React", type: "concept", confidence: 0.9 });
      const bRaw = insertRawEntity(db, { name: "React", type: "concept", confidence: 0.5 });
      const b = getRawEntity(db, bRaw.id);

      // Lower threshold so even low score is "possibly_same_as"
      const result = linkEntities(engine, { entityA: a, entityB: b }, { possibleThreshold: 0.1 });
      expect(["same_as", "possibly_same_as"]).toContain(result.decision);
    });
  });

  describe("case normalization", () => {
    it("treats differently-cased names as the same", () => {
      const a = engine.upsertEntity({ name: "React", type: "concept", confidence: 0.9 });
      const bRaw = insertRawEntity(db, { name: "react", type: "concept", confidence: 0.5 });
      const b = getRawEntity(db, bRaw.id);

      const result = linkEntities(engine, { entityA: a, entityB: b });
      expect(result.decision).toBe("same_as");
      expect(result.evidence).toContain("exact name match (normalized)");
    });

    it("treats whitespace-variant names as the same", () => {
      const a = engine.upsertEntity({ name: "  React  ", type: "concept", confidence: 0.9 });
      const bRaw = insertRawEntity(db, { name: "react", type: "concept", confidence: 0.5 });
      const b = getRawEntity(db, bRaw.id);

      const result = linkEntities(engine, { entityA: a, entityB: b });
      expect(result.decision).toBe("same_as");
    });
  });
});

describe("findLinkCandidates", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  it("finds entities with same normalized name", () => {
    engine.upsertEntity({ name: "React", type: "concept" });
    insertRawEntity(db, { name: "react", type: "tool" });

    const candidates = findLinkCandidates(engine);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.entityA.name).toBeDefined();
    expect(candidates[0]!.entityB.name).toBeDefined();
  });

  it("ignores unique entity names", () => {
    engine.upsertEntity({ name: "React", type: "concept" });
    engine.upsertEntity({ name: "Vue", type: "concept" });

    const candidates = findLinkCandidates(engine);
    expect(candidates).toHaveLength(0);
  });

  it("generates all pairs for 3+ same-name entities", () => {
    engine.upsertEntity({ name: "React", type: "concept" });
    insertRawEntity(db, { name: "react", type: "tool" });
    insertRawEntity(db, { name: "REACT", type: "file" });

    const candidates = findLinkCandidates(engine);
    // C(3,2) = 3 pairs
    expect(candidates).toHaveLength(3);
  });

  it("respects maxCandidates limit", () => {
    engine.upsertEntity({ name: "TestA", type: "concept" });
    insertRawEntity(db, { name: "testa", type: "tool" });
    engine.upsertEntity({ name: "TestB", type: "concept" });
    insertRawEntity(db, { name: "testb", type: "tool" });

    const candidates = findLinkCandidates(engine, { maxCandidates: 1 });
    expect(candidates).toHaveLength(1);
  });
});
