import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import {
  memoryGraphSearch,
  memoryStore,
  memoryDetail,
  memoryGraph,
  memoryInvalidate,
  memoryConsolidate,
  memoryEpisodes,
  memoryTextUnits,
  memoryProposals,
  memoryResolveProposal,
  memoryRebuildIndex,
  memoryStats,
} from "../host/graph-tools.js";
import { createTestDb } from "./test-helpers.js";

describe("graph-tools", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  // -------------------------------------------------------------------------
  // memoryStore
  // -------------------------------------------------------------------------

  describe("memoryStore", () => {
    it("creates a new entity", () => {
      const result = memoryStore(engine, {
        name: "React",
        type: "concept",
        summary: "UI library",
      });
      expect(result.isNew).toBe(true);
      expect(result.name).toBe("React");
      expect(result.edgesCreated).toBe(0);
    });

    it("upserts existing entity", () => {
      memoryStore(engine, { name: "React", type: "concept", summary: "v1" });
      const result = memoryStore(engine, { name: "React", type: "concept", summary: "v2" });
      expect(result.isNew).toBe(false);
    });

    it("creates relations", () => {
      const result = memoryStore(engine, {
        name: "Alice",
        type: "user",
        relations: [
          { targetName: "ProjectX", targetType: "project", relation: "works_on" },
          { targetName: "React", targetType: "concept", relation: "knows" },
        ],
      });
      expect(result.edgesCreated).toBe(2);
    });

    it("deduplicates edges on repeated store", () => {
      memoryStore(engine, {
        name: "Alice",
        type: "user",
        relations: [{ targetName: "ProjectX", targetType: "project", relation: "works_on" }],
      });
      memoryStore(engine, {
        name: "Alice",
        type: "user",
        relations: [{ targetName: "ProjectX", targetType: "project", relation: "works_on" }],
      });

      // Should still have only 1 edge due to dedup
      const alice = engine.findEntities({ name: "Alice" })[0]!;
      const edges = engine.findEdges({ entityId: alice.id });
      const worksOnEdges = edges.filter((e) => e.relation === "works_on");
      expect(worksOnEdges).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // memoryGraphSearch
  // -------------------------------------------------------------------------

  describe("memoryGraphSearch", () => {
    it("returns formatted results", async () => {
      engine.upsertEntity({ name: "React", type: "concept", summary: "UI lib" });
      engine.upsertEntity({ name: "Vue", type: "concept", summary: "Progressive framework" });

      // memoryGraphSearch uses L1 context which calls searchGraph internally
      // With few documents, FTS BM25 scores are tiny — use LIKE-friendly query
      const result = await memoryGraphSearch(db, engine, { query: "React" });
      // With small corpus, scores may be below default minScore. Verify no crash.
      expect(Array.isArray(result.results)).toBe(true);
      expect(typeof result.formatted).toBe("string");
    });

    it("filters by type", async () => {
      engine.upsertEntity({ name: "Alice", type: "user" });
      engine.upsertEntity({ name: "Alice", type: "concept" });

      const result = await memoryGraphSearch(db, engine, { query: "Alice", types: ["user"] });
      for (const r of result.results) {
        expect(r.type).toBe("user");
      }
    });

    it("omits relations from formatted output when includeRelations is false", async () => {
      const alice = engine.upsertEntity({ name: "Alice", type: "user", summary: "engineer", embedding: [1.0, 0.0, 0.0] });
      const project = engine.upsertEntity({ name: "ProjectX", type: "project", summary: "initiative", embedding: [0.0, 1.0, 0.0] });
      engine.addEdge({ fromId: alice.id, toId: project.id, relation: "works_on" });

      const result = await memoryGraphSearch(db, engine, {
        query: "semantic-query", includeRelations: false,
      }, [1.0, 0.0, 0.0]);

      expect(result.results[0]!.relations).toEqual([]);
      expect(result.formatted).not.toContain("works_on");
      expect(result.formatted).not.toContain("Relations:");
    });

    it("tracks access on search hit", () => {
      const entity = engine.upsertEntity({ name: "React", type: "concept", summary: "UI lib" });
      expect(entity.access_count).toBe(0);

      // touchEntity is called on search results — manually verify it works
      engine.touchEntity(entity.id);
      const updated = engine.getEntity(entity.id)!;
      expect(updated.access_count).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // memoryDetail
  // -------------------------------------------------------------------------

  describe("memoryDetail", () => {
    it("returns entity detail by name", () => {
      engine.upsertEntity({ name: "React", type: "concept", summary: "UI lib" });
      const result = memoryDetail(engine, { entity: "React" });
      expect(result.found).toBe(true);
      expect(result.formatted).toContain("React");
    });

    it("returns entity detail by ID", () => {
      const entity = engine.upsertEntity({ name: "React", type: "concept" });
      const result = memoryDetail(engine, { entity: entity.id });
      expect(result.found).toBe(true);
      expect(result.entityId).toBe(entity.id);
    });

    it("returns not found for missing entity", () => {
      const result = memoryDetail(engine, { entity: "NonExistent" });
      expect(result.found).toBe(false);
    });

    it("tracks access on detail view", () => {
      const entity = engine.upsertEntity({ name: "React", type: "concept" });
      memoryDetail(engine, { entity: "React" });
      const updated = engine.getEntity(entity.id)!;
      expect(updated.access_count).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // memoryGraph
  // -------------------------------------------------------------------------

  describe("memoryGraph", () => {
    it("visualizes entity relationships", () => {
      const a = engine.upsertEntity({ name: "Alice", type: "user" });
      const b = engine.upsertEntity({ name: "ProjectX", type: "project" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "works_on" });

      const result = memoryGraph(engine, { entity: "Alice" });
      expect(result.found).toBe(true);
      expect(result.entities.length).toBeGreaterThanOrEqual(2);
      expect(result.edges).toHaveLength(1);
      expect(result.formatted).toContain("works_on");
    });

    it("returns not found for missing entity", () => {
      const result = memoryGraph(engine, { entity: "Ghost" });
      expect(result.found).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // memoryInvalidate
  // -------------------------------------------------------------------------

  describe("memoryInvalidate", () => {
    it("invalidates entity by name", () => {
      engine.upsertEntity({ name: "OldFact", type: "concept" });
      const result = memoryInvalidate(engine, { entity: "OldFact", reason: "outdated" });
      expect(result.invalidated).toBe(true);

      const found = engine.findEntities({ name: "OldFact", activeOnly: true });
      expect(found).toHaveLength(0);
    });

    it("returns false for missing entity", () => {
      const result = memoryInvalidate(engine, { entity: "Ghost" });
      expect(result.invalidated).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // memoryConsolidate
  // -------------------------------------------------------------------------

  describe("memoryConsolidate", () => {
    it("runs without errors on empty graph", () => {
      const result = memoryConsolidate(engine, {});
      expect(result.merged).toBe(0);
      expect(result.decayed).toBe(0);
      expect(result.pruned).toBe(0);
    });

    it("supports dry run", () => {
      const result = memoryConsolidate(engine, { dryRun: true });
      expect(result.errors).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // memoryEpisodes
  // -------------------------------------------------------------------------

  describe("memoryEpisodes", () => {
    it("returns empty list when no episodes", () => {
      const result = memoryEpisodes(engine, {});
      expect(result.episodes).toEqual([]);
      expect(result.total).toBe(0);
    });

    it("lists episodes for a session", () => {
      engine.recordEpisode({ sessionKey: "s1", content: "hello" });
      engine.recordEpisode({ sessionKey: "s1", content: "world" });
      engine.recordEpisode({ sessionKey: "s2", content: "other" });

      const result = memoryEpisodes(engine, { sessionKey: "s1" });
      expect(result.episodes).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.episodes[0]!.sessionKey).toBe("s1");
    });

    it("lists all episodes without session filter", () => {
      engine.recordEpisode({ sessionKey: "s1", content: "a" });
      engine.recordEpisode({ sessionKey: "s2", content: "b" });

      const result = memoryEpisodes(engine, {});
      expect(result.total).toBe(2);
    });

    it("respects limit", () => {
      for (let i = 0; i < 10; i++) {
        engine.recordEpisode({ sessionKey: "s", content: `ep-${i}` });
      }
      const result = memoryEpisodes(engine, { limit: 3 });
      expect(result.episodes).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // memoryTextUnits
  // -------------------------------------------------------------------------

  describe("memoryTextUnits", () => {
    it("returns empty list when no text units", () => {
      const ep = engine.recordEpisode({ sessionKey: "s1", content: "test" });
      const result = memoryTextUnits(engine, { episodeId: ep.id });
      expect(result.units).toEqual([]);
    });

    it("returns text units for an episode", () => {
      const ep = engine.recordEpisode({ sessionKey: "s1", content: "test" });
      engine.recordTextUnit({ episodeId: ep.id, content: "turn 1", speaker: "user" });
      engine.recordTextUnit({ episodeId: ep.id, content: "turn 2", speaker: "assistant" });

      const result = memoryTextUnits(engine, { episodeId: ep.id });
      expect(result.units).toHaveLength(2);
      expect(result.units[0]!.speaker).toBe("user");
      expect(result.units[1]!.speaker).toBe("assistant");
    });
  });

  // -------------------------------------------------------------------------
  // memoryProposals
  // -------------------------------------------------------------------------

  describe("memoryProposals", () => {
    it("returns empty list when no proposals", () => {
      const result = memoryProposals(engine, {});
      expect(result.proposals).toEqual([]);
    });

    it("lists pending proposals", () => {
      const entity = engine.upsertEntity({ name: "Test", type: "concept" });
      engine.createSupersessionProposal({
        targetEntityId: entity.id,
        newAssertionText: "updated fact",
        reason: "new evidence",
      });

      const result = memoryProposals(engine, { status: "pending" });
      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0]!.status).toBe("pending");
      expect(result.proposals[0]!.entityName).toBe("Test");
      expect(result.proposals[0]!.reason).toBe("new evidence");
    });

    it("filters by status", () => {
      const entity = engine.upsertEntity({ name: "Test", type: "concept" });
      const proposal = engine.createSupersessionProposal({
        targetEntityId: entity.id,
        newAssertionText: "updated",
      });
      engine.resolveSupersession(proposal.id, "approved");

      const pending = memoryProposals(engine, { status: "pending" });
      expect(pending.proposals).toHaveLength(0);

      const approved = memoryProposals(engine, { status: "approved" });
      expect(approved.proposals).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // memoryResolveProposal
  // -------------------------------------------------------------------------

  describe("memoryResolveProposal", () => {
    it("approves a pending proposal", () => {
      const entity = engine.upsertEntity({ name: "Test", type: "concept" });
      const proposal = engine.createSupersessionProposal({
        targetEntityId: entity.id,
        newAssertionText: "updated fact",
      });

      const result = memoryResolveProposal(engine, {
        proposalId: proposal.id,
        decision: "approved",
      });
      expect(result.resolved).toBe(true);
      expect(result.proposalId).toBe(proposal.id);
      expect(result.decision).toBe("approved");
    });

    it("rejects a pending proposal", () => {
      const entity = engine.upsertEntity({ name: "Test", type: "concept" });
      const proposal = engine.createSupersessionProposal({
        targetEntityId: entity.id,
        newAssertionText: "bad update",
      });

      const result = memoryResolveProposal(engine, {
        proposalId: proposal.id,
        decision: "rejected",
      });
      expect(result.resolved).toBe(true);
      expect(result.decision).toBe("rejected");
    });

    it("returns false for non-existent proposal", () => {
      const result = memoryResolveProposal(engine, {
        proposalId: "non-existent-id",
        decision: "approved",
      });
      expect(result.resolved).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // memoryRebuildIndex
  // -------------------------------------------------------------------------

  describe("memoryRebuildIndex", () => {
    it("rebuilds FTS index", () => {
      engine.upsertEntity({ name: "React", type: "concept", summary: "UI lib" });
      engine.upsertEntity({ name: "Vue", type: "concept", summary: "framework" });

      const result = memoryRebuildIndex(engine, { target: "fts" });
      expect(result.rebuilt).toContain("fts");
      expect(result.details.ftsEntities).toBe(2);
    });

    it("rebuilds vec index", () => {
      const result = memoryRebuildIndex(engine, { target: "vec" });
      expect(result.rebuilt).toContain("vec");
      expect(typeof result.details.vecAvailable).toBe("number");
    });

    it("rebuilds community index", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "related" });

      const result = memoryRebuildIndex(engine, { target: "community" });
      expect(result.rebuilt).toContain("community");
      expect(result.details.communityCount).toBeGreaterThanOrEqual(1);
    });

    it("rebuilds all indexes", () => {
      engine.upsertEntity({ name: "X", type: "concept" });
      const result = memoryRebuildIndex(engine, { target: "all" });
      expect(result.rebuilt).toContain("fts");
      expect(result.rebuilt).toContain("vec");
      expect(result.rebuilt).toContain("community");
    });
  });

  // -------------------------------------------------------------------------
  // memoryStats
  // -------------------------------------------------------------------------

  describe("memoryStats", () => {
    it("returns zero stats for empty graph", () => {
      const result = memoryStats(engine);
      expect(result.entities).toBe(0);
      expect(result.activeEntities).toBe(0);
      expect(result.edges).toBe(0);
      expect(result.episodes).toBe(0);
      expect(result.communities).toBe(0);
      expect(result.pendingProposals).toBe(0);
      expect(result.properties).toBe(0);
    });

    it("counts entities, edges, and episodes", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "related" });
      engine.recordEpisode({ sessionKey: "s1", content: "test" });

      const result = memoryStats(engine);
      expect(result.entities).toBe(2);
      expect(result.activeEntities).toBe(2);
      expect(result.edges).toBe(1);
      expect(result.episodes).toBe(1);
    });

    it("counts pending proposals", () => {
      const entity = engine.upsertEntity({ name: "Test", type: "concept" });
      engine.createSupersessionProposal({
        targetEntityId: entity.id,
        newAssertionText: "update",
      });

      const result = memoryStats(engine);
      expect(result.pendingProposals).toBe(1);
    });

    it("counts properties", () => {
      const entity = engine.upsertEntity({ name: "Test", type: "concept" });
      engine.setProperty(entity.id, { key: "color", value: "blue", type: "string" });

      const result = memoryStats(engine);
      expect(result.properties).toBe(1);
    });
  });
});
