/**
 * Performance benchmarks for openclaw-memory.
 * Run with: npx vitest bench
 */

import { bench, describe, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import { searchGraph } from "../host/graph-search.js";
import { ensureGraphSchema } from "../host/graph-schema.js";
import { detectCommunities } from "../host/graph-community.js";

function createBenchDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  ensureGraphSchema({ db, ftsEnabled: true });
  return db;
}

function populateGraph(engine: MemoryGraphEngine, count: number) {
  const entities = [];
  for (let i = 0; i < count; i++) {
    entities.push(
      engine.upsertEntity({
        name: `Entity_${i}`,
        type: i % 3 === 0 ? "concept" : i % 3 === 1 ? "user" : "project",
        summary: `Description for entity number ${i}. Contains some text for FTS indexing.`,
      }),
    );
  }
  // Create edges (each entity connects to 2-3 others)
  for (let i = 0; i < count; i++) {
    const targets = [i + 1, i + 2, i + 10].filter((t) => t < count);
    for (const t of targets) {
      engine.addEdge({
        fromId: entities[i]!.id,
        toId: entities[t]!.id,
        relation: "relates_to",
      });
    }
  }
  return entities;
}

describe("entity operations", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createBenchDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  bench("upsertEntity (new)", () => {
    engine.upsertEntity({
      name: `Bench_${Math.random()}`,
      type: "concept",
      summary: "benchmark entity",
    });
  });

  bench("upsertEntity (update existing)", () => {
    engine.upsertEntity({ name: "FixedName", type: "concept", summary: "updated" });
  });

  bench("findEntities (by type)", () => {
    populateGraph(engine, 100);
    engine.findEntities({ type: "concept" });
  });

  bench("getEntity (by id)", () => {
    const entities = populateGraph(engine, 100);
    engine.getEntity(entities[50]!.id);
  });
});

describe("search operations (100 entities)", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createBenchDb();
    engine = new MemoryGraphEngine(db);
    populateGraph(engine, 100);
  });
  afterEach(() => db.close());

  bench("searchGraph (FTS only)", () => {
    searchGraph(db, engine, "Entity_50", {
      vectorWeight: 0,
      ftsWeight: 1,
      graphWeight: 0,
    });
  });

  bench("searchGraph (hybrid)", () => {
    searchGraph(db, engine, "Entity_50");
  });

  bench("searchGraph (cached)", () => {
    // First call populates cache
    searchGraph(db, engine, "CachedQuery");
    // Second call hits cache
    searchGraph(db, engine, "CachedQuery");
  });
});

describe("search operations (1000 entities)", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createBenchDb();
    engine = new MemoryGraphEngine(db);
    populateGraph(engine, 1000);
  });
  afterEach(() => db.close());

  bench("searchGraph (FTS only, 1K)", () => {
    searchGraph(db, engine, "Entity_500", {
      vectorWeight: 0,
      ftsWeight: 1,
      graphWeight: 0,
    });
  });

  bench("searchGraph (hybrid, 1K)", () => {
    searchGraph(db, engine, "Entity_500");
  });
});

describe("graph operations", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createBenchDb();
    engine = new MemoryGraphEngine(db);
    populateGraph(engine, 200);
  });
  afterEach(() => db.close());

  bench("getNeighbors (depth=1)", () => {
    const entities = engine.getActiveEntities();
    engine.getNeighbors(entities[50]!.id, 1);
  });

  bench("getNeighbors (depth=2)", () => {
    const entities = engine.getActiveEntities();
    engine.getNeighbors(entities[50]!.id, 2);
  });

  bench("findPaths (maxDepth=3)", () => {
    const entities = engine.getActiveEntities();
    engine.findPaths(entities[0]!.id, entities[10]!.id, { maxDepth: 3 });
  });

  bench("detectCommunities (200 entities)", () => {
    detectCommunities(engine);
  });
});

describe("batch operations", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createBenchDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  bench("upsertEntities (batch of 50)", () => {
    const inputs = Array.from({ length: 50 }, (_, i) => ({
      name: `Batch_${i}_${Math.random()}`,
      type: "concept" as const,
      summary: `Batch entity ${i}`,
    }));
    engine.upsertEntities(inputs);
  });

  bench("addEdges (batch of 50)", () => {
    const entities = populateGraph(engine, 100);
    const edges = Array.from({ length: 50 }, (_, i) => ({
      fromId: entities[i]!.id,
      toId: entities[(i + 1) % 100]!.id,
      relation: "batch_rel",
    }));
    engine.addEdges(edges);
  });
});
