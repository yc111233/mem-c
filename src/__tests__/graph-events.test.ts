import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import { createTestDb } from "./test-helpers.js";

describe("graph events", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  it("emits entity:created on new entity", () => {
    const events: string[] = [];
    engine.getEvents().on("entity:created", (e) => events.push(e.name));
    engine.upsertEntity({ name: "A", type: "concept" });
    expect(events).toEqual(["A"]);
  });

  it("emits entity:updated on existing entity", () => {
    engine.upsertEntity({ name: "A", type: "concept", summary: "v1" });
    const events: string[] = [];
    engine.getEvents().on("entity:updated", (e) => events.push(e.summary ?? ""));
    engine.upsertEntity({ name: "A", type: "concept", summary: "v2" });
    expect(events).toEqual(["v2"]);
  });

  it("emits entity:invalidated on invalidation", () => {
    const entity = engine.upsertEntity({ name: "A", type: "concept" });
    const invalidated: string[] = [];
    engine.getEvents().on("entity:invalidated", (id) => invalidated.push(id));
    engine.invalidateEntity(entity.id);
    expect(invalidated).toEqual([entity.id]);
  });

  it("emits edge:created on new edge", () => {
    const a = engine.upsertEntity({ name: "A", type: "concept" });
    const b = engine.upsertEntity({ name: "B", type: "concept" });
    const relations: string[] = [];
    engine.getEvents().on("edge:created", (e) => relations.push(e.relation));
    engine.addEdge({ fromId: a.id, toId: b.id, relation: "knows" });
    expect(relations).toEqual(["knows"]);
  });

  it("emits edge:updated on duplicate edge", () => {
    const a = engine.upsertEntity({ name: "A", type: "concept" });
    const b = engine.upsertEntity({ name: "B", type: "concept" });
    engine.addEdge({ fromId: a.id, toId: b.id, relation: "knows" });
    const updates: number[] = [];
    engine.getEvents().on("edge:updated", (e) => updates.push(e.weight));
    engine.addEdge({ fromId: a.id, toId: b.id, relation: "knows", weight: 2.0 });
    expect(updates.length).toBe(1);
    expect(updates[0]).toBe(2.0);
  });
});
