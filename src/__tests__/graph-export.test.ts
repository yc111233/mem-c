import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import { exportGraph } from "../host/graph-export.js";
import { createTestDb } from "./test-helpers.js";

describe("graph export", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  function createSampleGraph() {
    const a = engine.upsertEntity({ name: "Alice", type: "user" });
    const b = engine.upsertEntity({ name: "React", type: "concept" });
    const c = engine.upsertEntity({ name: "ProjectX", type: "project" });
    engine.addEdge({ fromId: a.id, toId: b.id, relation: "knows" });
    engine.addEdge({ fromId: a.id, toId: c.id, relation: "works_on" });
    engine.addEdge({ fromId: b.id, toId: c.id, relation: "used_in" });
    return { a, b, c };
  }

  describe("mermaid format", () => {
    it("produces valid Mermaid graph syntax", () => {
      createSampleGraph();
      const result = exportGraph(engine, { format: "mermaid" });

      expect(result.content).toContain("graph LR");
      expect(result.content).toContain("Alice");
      expect(result.content).toContain("React");
      expect(result.content).toContain("ProjectX");
      expect(result.content).toContain("knows");
      expect(result.content).toContain("works_on");
      expect(result.entityCount).toBe(3);
      expect(result.edgeCount).toBe(3);
    });

    it("sanitizes special characters in entity names in Mermaid", () => {
      const a = engine.upsertEntity({ name: "Node (test)", type: "concept" });
      const b = engine.upsertEntity({ name: "Node [v2]", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

      const result = exportGraph(engine, { format: "mermaid" });
      // Names should have special chars replaced with underscores
      expect(result.content).toContain("Node _test_");
      expect(result.content).toContain("Node _v2_");
      expect(result.content).not.toContain("Node (test)");
      expect(result.content).not.toContain("Node [v2]");
    });
  });

  describe("dot format", () => {
    it("produces valid DOT graph syntax", () => {
      createSampleGraph();
      const result = exportGraph(engine, { format: "dot" });

      expect(result.content).toContain("digraph");
      expect(result.content).toContain("Alice");
      expect(result.content).toContain("React");
      expect(result.content).toContain("->");
      expect(result.content).toContain("knows");
    });
  });

  describe("json format", () => {
    it("produces valid JSON with nodes and edges", () => {
      createSampleGraph();
      const result = exportGraph(engine, { format: "json" });

      const parsed = JSON.parse(result.content);
      expect(parsed.nodes.length).toBe(3);
      expect(parsed.edges.length).toBe(3);
      expect(parsed.nodes[0]).toHaveProperty("id");
      expect(parsed.nodes[0]).toHaveProperty("name");
      expect(parsed.nodes[0]).toHaveProperty("type");
      expect(parsed.edges[0]).toHaveProperty("from");
      expect(parsed.edges[0]).toHaveProperty("to");
      expect(parsed.edges[0]).toHaveProperty("relation");
    });
  });

  describe("options", () => {
    it("supports centerEntity option for focused export", () => {
      const { a } = createSampleGraph();
      const result = exportGraph(engine, {
        format: "mermaid",
        centerEntityId: a.id,
        depth: 1,
      });

      expect(result.content).toContain("Alice");
      expect(result.entityCount).toBeLessThanOrEqual(3);
    });

    it("handles empty graph", () => {
      const result = exportGraph(engine, { format: "mermaid" });
      expect(result.entityCount).toBe(0);
      expect(result.edgeCount).toBe(0);
    });
  });
});
