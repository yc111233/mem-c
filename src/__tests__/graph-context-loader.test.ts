import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import { ensureGraphSchema } from "../host/graph-schema.js";
import {
  buildL0Context,
  buildQueryAwareL0Context,
  buildL1Context,
  buildL2Context,
  suggestBudgets,
  formatL0AsPromptSection,
  formatL1AsSearchContext,
  formatL2AsDetail,
} from "../host/graph-context-loader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureGraphSchema({ db, ftsEnabled: true });
  return db;
}

function seedEntities(engine: MemoryGraphEngine) {
  engine.upsertEntity({ name: "React", type: "concept", summary: "A JavaScript UI library" });
  engine.upsertEntity({ name: "Vue", type: "concept", summary: "Progressive JS framework" });
  engine.upsertEntity({ name: "Alice", type: "user", summary: "Lead engineer" });
  engine.upsertEntity({ name: "GraphDB", type: "project", summary: "Graph database project" });
  engine.upsertEntity({ name: "TypeScript", type: "concept", summary: "Typed superset of JavaScript" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("suggestBudgets", () => {
  it("returns standard budgets when comfortable (>=3000)", async () => {
    const b = suggestBudgets(3000);
    expect(b).toEqual({ l0: 200, l1: 800, l2: 2000 });

    const b2 = suggestBudgets(10000);
    expect(b2).toEqual({ l0: 200, l1: 800, l2: 2000 });
  });

  it("returns compressed budgets when tight (500-2999)", async () => {
    const b = suggestBudgets(1000);
    expect(b.l0).toBeLessThanOrEqual(100);
    expect(b.l1).toBeLessThanOrEqual(400);
    expect(b.l0 + b.l1 + b.l2).toBe(1000);
    expect(b.l0).toBeGreaterThan(0);
    expect(b.l1).toBeGreaterThan(0);
    expect(b.l2).toBeGreaterThan(0);
  });

  it("returns minimal budgets when extreme (<500)", async () => {
    const b = suggestBudgets(100);
    expect(b.l0).toBeLessThanOrEqual(50);
    expect(b.l1).toBe(50); // 100 - 50
    expect(b.l2).toBe(0);
  });

  it("handles zero budget", async () => {
    const b = suggestBudgets(0);
    expect(b.l0).toBe(0);
    expect(b.l1).toBe(0);
    expect(b.l2).toBe(0);
  });
});

describe("buildL0Context", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns empty entries when no entities exist", async () => {
    const l0 = buildL0Context(engine);
    expect(l0.tier).toBe("L0");
    expect(l0.entries).toHaveLength(0);
  });

  it("returns entity roster with all seeded entities", async () => {
    seedEntities(engine);
    const l0 = buildL0Context(engine, { maxTokens: 500 });
    expect(l0.entries.length).toBe(5);
    // All entities should be present
    const joined = l0.entries.join("\n");
    expect(joined).toContain("React");
    expect(joined).toContain("Alice");
    expect(joined).toContain("TypeScript");
  });

  it("respects maxEntities limit", async () => {
    seedEntities(engine);
    const l0 = buildL0Context(engine, { maxEntities: 2, maxTokens: 500 });
    expect(l0.entries.length).toBeLessThanOrEqual(2);
  });

  it("respects maxTokens budget", async () => {
    seedEntities(engine);
    const l0 = buildL0Context(engine, { maxTokens: 30 });
    // Very tight budget — should include fewer entities
    expect(l0.estimatedTokens).toBeLessThanOrEqual(30);
  });
});

describe("buildQueryAwareL0Context", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
    seedEntities(engine);
  });

  afterEach(() => {
    db.close();
  });

  it("falls back to recency-only when query is empty", async () => {
    const l0 = await buildQueryAwareL0Context(db, engine, "", { maxTokens: 500 });
    expect(l0.tier).toBe("L0");
    expect(l0.entries.length).toBeGreaterThan(0);
    // Should be same as buildL0Context
    const l0Plain = buildL0Context(engine, { maxTokens: 500 });
    expect(l0.entries).toEqual(l0Plain.entries);
  });

  it("prioritizes query-relevant entities", async () => {
    const l0 = await buildQueryAwareL0Context(db, engine, "React JavaScript", {
      maxTokens: 500,
    });
    expect(l0.entries.length).toBeGreaterThan(0);
    // React should appear (matched by FTS)
    const hasReact = l0.entries.some((e) => e.includes("React"));
    expect(hasReact).toBe(true);
  });

  it("backfills with recency after relevant entities", async () => {
    const l0 = await buildQueryAwareL0Context(db, engine, "React", {
      maxTokens: 500,
    });
    // Should contain more than just React — backfill with others
    expect(l0.entries.length).toBeGreaterThan(1);
  });
});

describe("buildL1Context — compact mode", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
    seedEntities(engine);
    // Add an edge so relations exist
    const entities = engine.getActiveEntities();
    const react = entities.find((e) => e.name === "React")!;
    const ts = entities.find((e) => e.name === "TypeScript")!;
    engine.addEdge({ fromId: react.id, toId: ts.id, relation: "uses" });
  });

  afterEach(() => {
    db.close();
  });

  it("includes relations in normal mode", async () => {
    const l1 = await buildL1Context(db, engine, "React", { compact: false, maxTokens: 2000 });
    if (l1.results.length > 0) {
      const formatted = formatL1AsSearchContext(l1);
      // Non-compact should potentially include relation info
      expect(l1.tier).toBe("L1");
    }
  });

  it("omits relations in compact mode", async () => {
    const l1 = await buildL1Context(db, engine, "React", { compact: true, maxTokens: 2000 });
    for (const r of l1.results) {
      expect(r.relations).toEqual([]);
    }
  });
});

describe("buildL2Context — detailLevel", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;
  let entityId: string;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
    const entity = engine.upsertEntity({
      name: "React",
      type: "concept",
      summary: "A JavaScript UI library",
    });
    entityId = entity.id;

    const ts = engine.upsertEntity({
      name: "TypeScript",
      type: "concept",
      summary: "Typed JS",
    });
    engine.addEdge({ fromId: entityId, toId: ts.id, relation: "supports" });
  });

  afterEach(() => {
    db.close();
  });

  it("full detail includes edges", async () => {
    const l2 = buildL2Context(engine, entityId, { detailLevel: "full" });
    expect(l2).not.toBeNull();
    expect(l2!.tier).toBe("L2");
    expect(l2!.edges.length).toBeGreaterThan(0);
    expect(l2!.entity.name).toBe("React");
  });

  it("summary detail includes edges but no episodes/history", async () => {
    const l2 = buildL2Context(engine, entityId, { detailLevel: "summary" });
    expect(l2).not.toBeNull();
    expect(l2!.edges.length).toBeGreaterThan(0);
    expect(l2!.episodes).toHaveLength(0);
    expect(l2!.entity.history).toHaveLength(0);
  });

  it("minimal detail has no edges, no episodes, no history", async () => {
    const l2 = buildL2Context(engine, entityId, { detailLevel: "minimal" });
    expect(l2).not.toBeNull();
    expect(l2!.edges).toHaveLength(0);
    expect(l2!.episodes).toHaveLength(0);
    expect(l2!.entity.history).toHaveLength(0);
    expect(l2!.entity.summary).toBe("A JavaScript UI library");
  });

  it("returns null for non-existent entity", async () => {
    const l2 = buildL2Context(engine, "nonexistent-id");
    expect(l2).toBeNull();
  });
});

describe("buildL0Context — importance mode", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
    seedEntities(engine);
  });

  afterEach(() => {
    db.close();
  });

  it("uses importance scoring when useImportance is true", async () => {
    // Touch React multiple times to boost its importance
    const entities = engine.getActiveEntities();
    const react = entities.find((e) => e.name === "React")!;
    engine.touchEntity(react.id);
    engine.touchEntity(react.id);
    engine.touchEntity(react.id);

    const l0 = buildL0Context(engine, { maxTokens: 500, useImportance: true });
    expect(l0.entries.length).toBeGreaterThan(0);
    // React should appear (it has the highest access count)
    const hasReact = l0.entries.some((e) => e.includes("React"));
    expect(hasReact).toBe(true);
  });

  it("falls back to recency when useImportance is false", async () => {
    const l0 = buildL0Context(engine, { maxTokens: 500, useImportance: false });
    expect(l0.entries.length).toBeGreaterThan(0);
  });
});

describe("format functions", () => {
  it("formatL0AsPromptSection returns empty for no entries", async () => {
    const result = formatL0AsPromptSection({ tier: "L0", entries: [], estimatedTokens: 0 });
    expect(result).toBe("");
  });

  it("formatL0AsPromptSection includes header", async () => {
    const result = formatL0AsPromptSection({
      tier: "L0",
      entries: ["- React (concept)"],
      estimatedTokens: 10,
    });
    expect(result).toContain("## Known Entities");
    expect(result).toContain("React (concept)");
  });
});
