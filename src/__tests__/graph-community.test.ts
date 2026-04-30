import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import { detectCommunities, getCommunities, getCommunityForEntity, getCommunityReport, getGlobalCommunityReports, summarizeCommunities, type SummarizeFn } from "../host/graph-community.js";
import { createTestDb } from "./test-helpers.js";

describe("community detection", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  describe("detectCommunities", () => {
    it("finds a single connected component", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      const c = engine.upsertEntity({ name: "C", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });
      engine.addEdge({ fromId: b.id, toId: c.id, relation: "relates" });

      const result = detectCommunities(engine);
      expect(result.communities.length).toBe(1);
      expect(result.communities[0]!.entityCount).toBe(3);
      expect(result.totalEntities).toBe(3);
    });

    it("finds multiple disconnected components", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

      const c = engine.upsertEntity({ name: "C", type: "concept" });
      const d = engine.upsertEntity({ name: "D", type: "concept" });
      engine.addEdge({ fromId: c.id, toId: d.id, relation: "relates" });

      engine.upsertEntity({ name: "E", type: "concept" }); // isolated

      const result = detectCommunities(engine);
      expect(result.communities.length).toBe(3);
      const sizes = result.communities.map((c) => c.entityCount).sort();
      expect(sizes).toEqual([1, 2, 2]);
    });

    it("handles empty graph", () => {
      const result = detectCommunities(engine);
      expect(result.communities.length).toBe(0);
      expect(result.totalEntities).toBe(0);
    });

    it("respects activeOnly flag", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });
      engine.invalidateEntity(a.id);

      const result = detectCommunities(engine, { activeOnly: true });
      expect(result.communities.length).toBe(1);
      expect(result.communities[0]!.entityCount).toBe(1);
    });

    it("stores results in database", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

      detectCommunities(engine);

      const stored = getCommunities(engine);
      expect(stored.length).toBe(1);
      expect(stored[0]!.entityCount).toBe(2);
    });

    it("clears old communities on re-detect", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

      detectCommunities(engine);
      detectCommunities(engine); // re-run

      const stored = getCommunities(engine);
      expect(stored.length).toBe(1); // not 2
    });
  });

  describe("getCommunityForEntity", () => {
    it("returns community for a given entity", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

      detectCommunities(engine);

      const community = getCommunityForEntity(engine, a.id);
      expect(community).not.toBeNull();
      expect(community!.entityCount).toBe(2);
    });

    it("returns null for entity not in any community", () => {
      const community = getCommunityForEntity(engine, "nonexistent");
      expect(community).toBeNull();
    });
  });

  describe("summarizeCommunities", () => {
    it("calls summarizeFn for each community and stores label", async () => {
      const a = engine.upsertEntity({ name: "React", type: "concept", summary: "UI library" });
      const b = engine.upsertEntity({ name: "Vue", type: "concept", summary: "Progressive framework" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

      detectCommunities(engine);

      const mockSummarize = async () => ({ label: "Frontend frameworks", summary: "React and Vue are popular frontend frameworks for building UIs." });
      const result = await summarizeCommunities(engine, mockSummarize);

      expect(result.summarized).toBe(1);

      const communities = getCommunities(engine);
      expect(communities[0]!.label).toBe("Frontend frameworks");
      expect(communities[0]!.reportSummary).toBe("React and Vue are popular frontend frameworks for building UIs.");
    });

    it("handles multiple communities", async () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

      const c = engine.upsertEntity({ name: "C", type: "concept" });
      const d = engine.upsertEntity({ name: "D", type: "concept" });
      engine.addEdge({ fromId: c.id, toId: d.id, relation: "relates" });

      detectCommunities(engine);

      let callCount = 0;
      const mockSummarize = async () => {
        callCount++;
        return { label: `Summary ${callCount}`, summary: `Description for community ${callCount}` };
      };

      const result = await summarizeCommunities(engine, mockSummarize);
      expect(result.summarized).toBe(2);
    });

    it("skips summarizeFn errors gracefully", async () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

      detectCommunities(engine);

      const mockSummarize: SummarizeFn = async () => {
        throw new Error("LLM unavailable");
      };

      const result = await summarizeCommunities(engine, mockSummarize);
      expect(result.summarized).toBe(0);
      expect(result.errors.length).toBe(1);
    });

    it("returns 0 when no communities exist", async () => {
      const mockSummarize = async () => ({ label: "test", summary: "test summary" });
      const result = await summarizeCommunities(engine, mockSummarize);
      expect(result.summarized).toBe(0);
    });
  });

  describe("maxCommunitySize", () => {
    it("truncates component at maxCommunitySize without losing nodes", () => {
      // Create a chain: A-B-C-D-E (5 nodes in one component)
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      const c = engine.upsertEntity({ name: "C", type: "concept" });
      const d = engine.upsertEntity({ name: "D", type: "concept" });
      const e = engine.upsertEntity({ name: "E", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });
      engine.addEdge({ fromId: b.id, toId: c.id, relation: "relates" });
      engine.addEdge({ fromId: c.id, toId: d.id, relation: "relates" });
      engine.addEdge({ fromId: d.id, toId: e.id, relation: "relates" });

      // Detect with maxCommunitySize=2 — should still produce 1 community (truncated to 2)
      const result = detectCommunities(engine, { maxCommunitySize: 2 });
      expect(result.communities.length).toBe(1);
      expect(result.communities[0]!.entityCount).toBe(2);
      // Total entities should still be 5
      expect(result.totalEntities).toBe(5);
    });
  });

  describe("getCommunityReport", () => {
    it("returns report for a summarized community", async () => {
      const a = engine.upsertEntity({ name: "React", type: "concept", summary: "UI library" });
      const b = engine.upsertEntity({ name: "Vue", type: "concept", summary: "Progressive framework" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

      detectCommunities(engine);

      const mockSummarize = async () => ({ label: "Frontend frameworks", summary: "React and Vue are popular frontend frameworks for building UIs." });
      await summarizeCommunities(engine, mockSummarize);

      const communities = getCommunities(engine);
      const report = getCommunityReport(engine, communities[0]!.id);
      expect(report).not.toBeNull();
      expect(report!.label).toBe("Frontend frameworks");
      expect(report!.summary).toBe("React and Vue are popular frontend frameworks for building UIs.");
      expect(report!.entityCount).toBe(2);
    });

    it("returns null for nonexistent community", () => {
      const report = getCommunityReport(engine, "nonexistent");
      expect(report).toBeNull();
    });
  });

  describe("getGlobalCommunityReports", () => {
    it("returns all summarized communities", async () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

      const c = engine.upsertEntity({ name: "C", type: "concept" });
      const d = engine.upsertEntity({ name: "D", type: "concept" });
      engine.addEdge({ fromId: c.id, toId: d.id, relation: "relates" });

      detectCommunities(engine);

      let callCount = 0;
      const mockSummarize = async () => {
        callCount++;
        return { label: `Community ${callCount}`, summary: `Description ${callCount}` };
      };
      await summarizeCommunities(engine, mockSummarize);

      const reports = getGlobalCommunityReports(engine);
      expect(reports.length).toBe(2);
      expect(reports[0]!.label).toBeTruthy();
      expect(reports[0]!.summary).toBeTruthy();
    });

    it("returns empty array when no communities are summarized", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

      detectCommunities(engine);

      const reports = getGlobalCommunityReports(engine);
      expect(reports.length).toBe(0);
    });
  });
});
