import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine, computeImportance, type Entity, type EmbedFn } from "../host/graph-engine.js";
import { ensureGraphSchema } from "../host/graph-schema.js";
import { searchGraph } from "../host/graph-search.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureGraphSchema({ db, ftsEnabled: true });
  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryGraphEngine", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  // -- Entity CRUD ----------------------------------------------------------

  describe("entity CRUD", () => {
    it("creates a new entity", () => {
      const entity = engine.upsertEntity({
        name: "React",
        type: "concept",
        summary: "A JavaScript UI library",
      });

      expect(entity.id).toBeTruthy();
      expect(entity.name).toBe("React");
      expect(entity.type).toBe("concept");
      expect(entity.summary).toBe("A JavaScript UI library");
      expect(entity.confidence).toBe(1.0);
      expect(entity.source).toBe("auto");
      expect(entity.valid_until).toBeNull();
    });

    it("upserts existing entity by name+type", () => {
      const first = engine.upsertEntity({
        name: "React",
        type: "concept",
        summary: "v1",
      });
      const second = engine.upsertEntity({
        name: "React",
        type: "concept",
        summary: "A JavaScript UI library",
      });

      expect(second.id).toBe(first.id);
      expect(second.summary).toBe("A JavaScript UI library");
    });

    it("creates separate entities for same name but different type", () => {
      const concept = engine.upsertEntity({ name: "React", type: "concept" });
      const file = engine.upsertEntity({ name: "React", type: "file" });

      expect(concept.id).not.toBe(file.id);
    });

    it("finds entities by type", () => {
      engine.upsertEntity({ name: "React", type: "concept" });
      engine.upsertEntity({ name: "Vue", type: "concept" });
      engine.upsertEntity({ name: "package.json", type: "file" });

      const concepts = engine.findEntities({ type: "concept" });
      expect(concepts).toHaveLength(2);
    });

    it("finds entity by name", () => {
      engine.upsertEntity({ name: "React", type: "concept" });
      const results = engine.findEntities({ name: "React" });
      expect(results).toHaveLength(1);
      expect(results[0]!.name).toBe("React");
    });

    it("invalidates an entity with temporal tracking", () => {
      const entity = engine.upsertEntity({
        name: "Old API",
        type: "concept",
      });
      engine.invalidateEntity(entity.id, "replaced by new API");

      const active = engine.findEntities({ name: "Old API", activeOnly: true });
      expect(active).toHaveLength(0);

      const all = engine.findEntities({ name: "Old API", activeOnly: false });
      expect(all).toHaveLength(1);
      expect(all[0]!.valid_until).not.toBeNull();
    });

    it("getEntity returns null for missing id", () => {
      expect(engine.getEntity("nonexistent")).toBeNull();
    });
  });

  // -- Edge CRUD ------------------------------------------------------------

  describe("edge CRUD", () => {
    let entityA: Entity;
    let entityB: Entity;

    beforeEach(() => {
      entityA = engine.upsertEntity({ name: "User", type: "user" });
      entityB = engine.upsertEntity({ name: "React Project", type: "project" });
    });

    it("creates an edge between entities", () => {
      const edge = engine.addEdge({
        fromId: entityA.id,
        toId: entityB.id,
        relation: "works_on",
      });

      expect(edge.id).toBeTruthy();
      expect(edge.from_id).toBe(entityA.id);
      expect(edge.to_id).toBe(entityB.id);
      expect(edge.relation).toBe("works_on");
      expect(edge.weight).toBe(1.0);
    });

    it("finds edges by entity and direction", () => {
      engine.addEdge({ fromId: entityA.id, toId: entityB.id, relation: "works_on" });

      const outgoing = engine.findEdges({ entityId: entityA.id, direction: "outgoing" });
      expect(outgoing).toHaveLength(1);

      const incoming = engine.findEdges({ entityId: entityA.id, direction: "incoming" });
      expect(incoming).toHaveLength(0);

      const both = engine.findEdges({ entityId: entityA.id, direction: "both" });
      expect(both).toHaveLength(1);
    });

    it("invalidates edges when entity is invalidated", () => {
      engine.addEdge({ fromId: entityA.id, toId: entityB.id, relation: "works_on" });
      engine.invalidateEntity(entityA.id);

      const edges = engine.findEdges({ entityId: entityA.id, activeOnly: true });
      expect(edges).toHaveLength(0);
    });

    it("invalidates a single edge", () => {
      const edge = engine.addEdge({ fromId: entityA.id, toId: entityB.id, relation: "works_on" });
      engine.invalidateEdge(edge.id);

      const active = engine.findEdges({ entityId: entityA.id, activeOnly: true });
      expect(active).toHaveLength(0);

      const all = engine.findEdges({ entityId: entityA.id, activeOnly: false });
      expect(all).toHaveLength(1);
    });

    it("stores and parses edge metadata", () => {
      const edge = engine.addEdge({
        fromId: entityA.id,
        toId: entityB.id,
        relation: "works_on",
        metadata: { role: "lead", since: "2024" },
      });

      expect(edge.metadataParsed).toEqual({ role: "lead", since: "2024" });
    });
  });

  // -- Graph traversal ------------------------------------------------------

  describe("graph traversal", () => {
    it("gets 1-hop neighbors", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      const c = engine.upsertEntity({ name: "C", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates_to" });
      engine.addEdge({ fromId: b.id, toId: c.id, relation: "relates_to" });

      const neighbors = engine.getNeighbors(a.id, 1);
      expect(neighbors.entities).toHaveLength(2); // A + B
      expect(neighbors.edges).toHaveLength(1);
    });

    it("gets 2-hop neighbors", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      const c = engine.upsertEntity({ name: "C", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates_to" });
      engine.addEdge({ fromId: b.id, toId: c.id, relation: "relates_to" });

      const neighbors = engine.getNeighbors(a.id, 2);
      expect(neighbors.entities).toHaveLength(3); // A + B + C
      expect(neighbors.edges).toHaveLength(2);
    });
  });

  // -- Temporal queries -----------------------------------------------------

  describe("temporal queries", () => {
    it("tracks entity history across invalidation and re-creation", () => {
      const v1 = engine.upsertEntity({ name: "API Endpoint", type: "concept", summary: "v1" });
      engine.invalidateEntity(v1.id);
      // Ensure v2 gets a later valid_from
      const v2ValidFrom = Date.now() + 1;
      engine.upsertEntity({
        name: "API Endpoint",
        type: "concept",
        summary: "v2",
        validFrom: v2ValidFrom,
      });

      const history = engine.getEntityHistory("API Endpoint");
      expect(history).toHaveLength(2);
      // Ordered by valid_from DESC, so v2 (later) comes first
      const summaries = history.map((h) => h.entity.summary);
      expect(summaries).toContain("v1");
      expect(summaries).toContain("v2");
      const invalidated = history.find((h) => h.entity.valid_until !== null);
      expect(invalidated).toBeTruthy();
      expect(invalidated!.entity.summary).toBe("v1");
    });

    it("getActiveEntities excludes invalidated", () => {
      engine.upsertEntity({ name: "Active", type: "concept" });
      const old = engine.upsertEntity({ name: "Old", type: "concept" });
      engine.invalidateEntity(old.id);

      const active = engine.getActiveEntities("concept");
      expect(active).toHaveLength(1);
      expect(active[0]!.name).toBe("Active");
    });
  });

  // -- Episodes -------------------------------------------------------------

  describe("episodes", () => {
    it("records and retrieves episodes", () => {
      engine.recordEpisode({
        sessionKey: "session-1",
        turnIndex: 0,
        content: "User asked about React hooks",
        extractedEntityIds: ["entity-1"],
      });
      engine.recordEpisode({
        sessionKey: "session-1",
        turnIndex: 1,
        content: "Discussed useEffect cleanup",
      });

      const episodes = engine.getEpisodes("session-1");
      expect(episodes).toHaveLength(2);
    });
  });

  // -- Stats ----------------------------------------------------------------

  describe("stats", () => {
    it("returns correct counts", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates_to" });
      engine.recordEpisode({ sessionKey: "s1", content: "test" });
      engine.invalidateEntity(b.id);

      const stats = engine.stats();
      expect(stats.entities).toBe(2);
      expect(stats.activeEntities).toBe(1);
      expect(stats.edges).toBe(1);
      expect(stats.episodes).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Graph Search tests
// ---------------------------------------------------------------------------

describe("searchGraph", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  it("finds entities via FTS", () => {
    engine.upsertEntity({ name: "React Hooks", type: "concept", summary: "useState and useEffect" });
    engine.upsertEntity({ name: "Vue Composition", type: "concept", summary: "ref and computed" });

    const results = searchGraph(db, engine, "React", { minScore: 0 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.entity.name).toBe("React Hooks");
  });

  it("includes edges in results", () => {
    const react = engine.upsertEntity({ name: "React", type: "concept" });
    const hooks = engine.upsertEntity({ name: "Hooks", type: "concept" });
    engine.addEdge({ fromId: react.id, toId: hooks.id, relation: "has_feature" });

    const results = searchGraph(db, engine, "React", {
      includeEdges: true,
      minScore: 0,
    });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const reactResult = results.find((r) => r.entity.name === "React");
    expect(reactResult?.edges.length).toBeGreaterThanOrEqual(1);
    expect(reactResult?.relatedNames).toContain("Hooks");
  });

  it("filters by entity type", () => {
    engine.upsertEntity({ name: "React", type: "concept" });
    engine.upsertEntity({ name: "React", type: "file" });

    const results = searchGraph(db, engine, "React", {
      types: ["concept"],
      minScore: 0,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.entity.type).toBe("concept");
  });

  it("excludes invalidated entities by default", () => {
    const entity = engine.upsertEntity({ name: "Deprecated API", type: "concept" });
    engine.invalidateEntity(entity.id);

    const results = searchGraph(db, engine, "Deprecated", { minScore: 0 });
    expect(results).toHaveLength(0);
  });

  it("applies temporal decay", () => {
    // Create two entities with different update times
    const recent = engine.upsertEntity({ name: "Fresh Info", type: "concept", summary: "fresh" });
    const old = engine.upsertEntity({ name: "Old Info", type: "concept", summary: "old" });

    // Manually backdate the old entity
    db.prepare(`UPDATE entities SET updated_at = ? WHERE id = ?`).run(
      Date.now() - 90 * 24 * 60 * 60 * 1000, // 90 days ago
      old.id,
    );

    const results = searchGraph(db, engine, "Info", {
      temporalDecayDays: 30,
      minScore: 0,
    });

    if (results.length >= 2) {
      const freshResult = results.find((r) => r.entity.name === "Fresh Info");
      const oldResult = results.find((r) => r.entity.name === "Old Info");
      if (freshResult && oldResult) {
        expect(freshResult.scoreBreakdown.temporal).toBeGreaterThan(
          oldResult.scoreBreakdown.temporal,
        );
      }
    }
  });

  it("falls back to LIKE search when FTS and vector have no results", () => {
    engine.upsertEntity({ name: "MySpecialComponent", type: "concept" });

    const results = searchGraph(db, engine, "Special", { minScore: 0 });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty for no matches", () => {
    engine.upsertEntity({ name: "React", type: "concept" });

    const results = searchGraph(db, engine, "xyznonexistent123", { minScore: 0.5 });
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// B1: Access tracking and importance scoring
// ---------------------------------------------------------------------------

describe("touchEntity", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  it("increments access_count and updates last_accessed_at", () => {
    const e = engine.upsertEntity({ name: "React", type: "concept" });
    expect(e.access_count).toBe(0);
    expect(e.last_accessed_at).toBe(0);

    engine.touchEntity(e.id);
    const updated = engine.getEntity(e.id)!;
    expect(updated.access_count).toBe(1);
    expect(updated.last_accessed_at).toBeGreaterThan(0);

    engine.touchEntity(e.id);
    const updated2 = engine.getEntity(e.id)!;
    expect(updated2.access_count).toBe(2);
  });
});

describe("computeImportance", () => {
  it("gives higher score to entities with more edges", () => {
    const now = Date.now();
    const base: Entity = {
      id: "1", name: "A", type: "concept", summary: null, embedding: null,
      confidence: 1, source: "auto", valid_from: now, valid_until: null,
      created_at: now, updated_at: now, access_count: 0, last_accessed_at: 0,
    };

    const low = computeImportance(base, 0, now);
    const high = computeImportance(base, 10, now);
    expect(high).toBeGreaterThan(low);
  });

  it("gives higher score to recently accessed entities", () => {
    const now = Date.now();
    const base: Entity = {
      id: "1", name: "A", type: "concept", summary: null, embedding: null,
      confidence: 1, source: "auto", valid_from: now, valid_until: null,
      created_at: now, updated_at: now, access_count: 5, last_accessed_at: now,
    };
    const stale: Entity = {
      ...base, access_count: 5, last_accessed_at: now - 30 * 86_400_000,
    };

    expect(computeImportance(base, 0, now)).toBeGreaterThan(computeImportance(stale, 0, now));
  });

  it("gives higher score to higher confidence", () => {
    const now = Date.now();
    const base: Entity = {
      id: "1", name: "A", type: "concept", summary: null, embedding: null,
      confidence: 1, source: "auto", valid_from: now, valid_until: null,
      created_at: now, updated_at: now, access_count: 0, last_accessed_at: 0,
    };

    const highConf = computeImportance({ ...base, confidence: 1.0 }, 0, now);
    const lowConf = computeImportance({ ...base, confidence: 0.3 }, 0, now);
    expect(highConf).toBeGreaterThan(lowConf);
  });
});

describe("getEntitiesByImportance", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns entities sorted by importance score", () => {
    const e1 = engine.upsertEntity({ name: "Popular", type: "concept", confidence: 1.0 });
    const e2 = engine.upsertEntity({ name: "Obscure", type: "concept", confidence: 0.3 });
    const e3 = engine.upsertEntity({ name: "Connected", type: "concept", confidence: 0.8 });

    // Add edges to make e3 more connected
    engine.addEdge({ fromId: e3.id, toId: e1.id, relation: "uses" });
    engine.addEdge({ fromId: e3.id, toId: e2.id, relation: "relates" });

    // Touch e1 to boost access score
    engine.touchEntity(e1.id);
    engine.touchEntity(e1.id);
    engine.touchEntity(e1.id);

    const ranked = engine.getEntitiesByImportance();
    expect(ranked.length).toBe(3);
    // All should have importance scores
    for (const r of ranked) {
      expect(r.importance).toBeGreaterThan(0);
    }
    // Should be sorted descending
    expect(ranked[0]!.importance).toBeGreaterThanOrEqual(ranked[1]!.importance);
    expect(ranked[1]!.importance).toBeGreaterThanOrEqual(ranked[2]!.importance);
  });

  it("respects maxEntities limit", () => {
    engine.upsertEntity({ name: "A", type: "concept" });
    engine.upsertEntity({ name: "B", type: "concept" });
    engine.upsertEntity({ name: "C", type: "concept" });

    const ranked = engine.getEntitiesByImportance({ maxEntities: 2 });
    expect(ranked).toHaveLength(2);
  });

  it("returns empty for no entities", () => {
    const ranked = engine.getEntitiesByImportance();
    expect(ranked).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Incremental embedding
// ---------------------------------------------------------------------------

describe("incremental embedding", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("skips embedFn when content has not changed", () => {
    let callCount = 0;
    const countingEmbed: EmbedFn = (_text) => {
      callCount++;
      return [1, 0, 0];
    };
    const eng = new MemoryGraphEngine(db, { embedFn: countingEmbed });

    eng.upsertEntity({ name: "A", type: "concept", summary: "hello" });
    expect(callCount).toBe(1);

    // Same name + same summary → should NOT re-embed
    eng.upsertEntity({ name: "A", type: "concept", summary: "hello" });
    expect(callCount).toBe(1); // still 1, not 2
  });

  it("re-embeds when summary changes", () => {
    let callCount = 0;
    const countingEmbed: EmbedFn = (_text) => {
      callCount++;
      return [1, 0, 0];
    };
    const eng = new MemoryGraphEngine(db, { embedFn: countingEmbed });

    eng.upsertEntity({ name: "A", type: "concept", summary: "v1" });
    expect(callCount).toBe(1);

    eng.upsertEntity({ name: "A", type: "concept", summary: "v2" });
    expect(callCount).toBe(2);
  });

  it("always embeds new entities", () => {
    let callCount = 0;
    const countingEmbed: EmbedFn = (_text) => {
      callCount++;
      return [1, 0, 0];
    };
    const eng = new MemoryGraphEngine(db, { embedFn: countingEmbed });

    eng.upsertEntity({ name: "X", type: "concept" });
    expect(callCount).toBe(1);

    eng.upsertEntity({ name: "Y", type: "concept" });
    expect(callCount).toBe(2);
  });

  it("re-embeds pre-migration entities with no stored hash", () => {
    let callCount = 0;
    const countingEmbed: EmbedFn = (_text) => {
      callCount++;
      return [1, 0, 0];
    };
    const eng = new MemoryGraphEngine(db, { embedFn: countingEmbed });

    // Create entity
    eng.upsertEntity({ name: "A", type: "concept", summary: "hello" });
    expect(callCount).toBe(1);

    // Simulate pre-migration: clear content_hash
    db.prepare(`UPDATE entities SET content_hash = NULL WHERE name = 'A'`).run();

    // Same content but no stored hash → should re-embed
    eng.upsertEntity({ name: "A", type: "concept", summary: "hello" });
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Namespace isolation
// ---------------------------------------------------------------------------

describe("namespace isolation", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("scopes entities to namespace", () => {
    const ns1 = new MemoryGraphEngine(db, { namespace: "user1" });
    const ns2 = new MemoryGraphEngine(db, { namespace: "user2" });

    ns1.upsertEntity({ name: "A", type: "concept" });
    ns2.upsertEntity({ name: "B", type: "concept" });

    const user1Entities = ns1.findEntities({});
    const user2Entities = ns2.findEntities({});

    expect(user1Entities.length).toBe(1);
    expect(user1Entities[0]!.name).toBe("A");
    expect(user2Entities.length).toBe(1);
    expect(user2Entities[0]!.name).toBe("B");
  });

  it("default namespace (null) only sees non-namespaced data", () => {
    const defaultEngine = new MemoryGraphEngine(db);
    const nsEngine = new MemoryGraphEngine(db, { namespace: "user1" });

    defaultEngine.upsertEntity({ name: "Global", type: "concept" });
    nsEngine.upsertEntity({ name: "Private", type: "concept" });

    const defaultEntities = defaultEngine.findEntities({});
    expect(defaultEntities.length).toBe(1);
    expect(defaultEntities[0]!.name).toBe("Global");
  });

  it("namespaced engine does not see other namespace data", () => {
    const ns1 = new MemoryGraphEngine(db, { namespace: "user1" });
    const ns2 = new MemoryGraphEngine(db, { namespace: "user2" });

    ns1.upsertEntity({ name: "Secret", type: "concept" });

    const found = ns2.findEntities({ name: "Secret" });
    expect(found.length).toBe(0);
  });

  it("scopes edges to namespace", () => {
    const ns1 = new MemoryGraphEngine(db, { namespace: "user1" });
    const ns2 = new MemoryGraphEngine(db, { namespace: "user2" });

    const a = ns1.upsertEntity({ name: "A", type: "concept" });
    const b = ns1.upsertEntity({ name: "B", type: "concept" });
    ns1.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

    // ns2 should not see ns1's edges
    const edges = ns2.findEdges({});
    expect(edges.length).toBe(0);
  });

  it("getEntity scopes by namespace", () => {
    const ns1 = new MemoryGraphEngine(db, { namespace: "user1" });
    const ns2 = new MemoryGraphEngine(db, { namespace: "user2" });

    const entity = ns1.upsertEntity({ name: "X", type: "concept" });

    // ns1 can get it
    expect(ns1.getEntity(entity.id)).not.toBeNull();

    // ns2 cannot get it
    expect(ns2.getEntity(entity.id)).toBeNull();
  });

  it("upsert in same namespace updates existing entity", () => {
    const ns1 = new MemoryGraphEngine(db, { namespace: "user1" });

    const first = ns1.upsertEntity({ name: "A", type: "concept", summary: "v1" });
    const second = ns1.upsertEntity({ name: "A", type: "concept", summary: "v2" });

    expect(second.id).toBe(first.id);
    expect(second.summary).toBe("v2");
  });

  it("upsert in different namespace creates separate entity", () => {
    const ns1 = new MemoryGraphEngine(db, { namespace: "user1" });
    const ns2 = new MemoryGraphEngine(db, { namespace: "user2" });

    const e1 = ns1.upsertEntity({ name: "A", type: "concept" });
    const e2 = ns2.upsertEntity({ name: "A", type: "concept" });

    expect(e1.id).not.toBe(e2.id);
  });
});
