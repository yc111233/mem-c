import { describe, expect, it } from "vitest";
import { createMemoryMcpServer } from "../host/graph-mcp.js";

describe("MCP server", () => {
  it("creates server with engine and db", () => {
    const { server, engine, db } = createMemoryMcpServer();
    expect(server).toBeDefined();
    expect(engine).toBeDefined();
    expect(db).toBeDefined();
    db.close();
  });

  it("engine works through MCP-created instance", () => {
    const { engine, db } = createMemoryMcpServer();
    engine.upsertEntity({ name: "Test", type: "concept", summary: "test entity" });
    const entities = engine.findEntities({ name: "Test" });
    expect(entities.length).toBe(1);
    expect(entities[0]!.summary).toBe("test entity");
    db.close();
  });

  it("supports namespace option", () => {
    const { engine, db } = createMemoryMcpServer({ namespace: "user1" });
    engine.upsertEntity({ name: "Private", type: "concept" });
    const entities = engine.findEntities({});
    expect(entities.length).toBe(1);
    expect(entities[0]!.name).toBe("Private");
    db.close();
  });
});
