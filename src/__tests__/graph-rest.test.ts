import { describe, expect, it, afterEach } from "vitest";
import { startRestServer } from "../host/graph-rest.js";

describe("REST API", () => {
  let cleanup: (() => void) | null = null;
  let baseUrl = "";

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  async function startServer() {
    const { port, close } = await startRestServer();
    baseUrl = `http://127.0.0.1:${port}`;
    cleanup = close;
    return baseUrl;
  }

  it("health endpoint returns stats", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/health`);
    const data = await res.json();
    expect(data.status).toBe("ok");
    expect(data).toHaveProperty("entities");
    expect(data).toHaveProperty("edges");
  });

  it("POST /entities creates an entity", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/entities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test", type: "concept", summary: "test" }),
    });
    const data = await res.json();
    expect(data.name).toBe("Test");
    expect(data.isNew).toBe(true);
  });

  it("GET /search finds entities", async () => {
    await startServer();
    // Create several entities so FTS has enough documents for meaningful BM25 scores
    const entities = [
      { name: "React", type: "concept", summary: "UI library" },
      { name: "Vue", type: "concept", summary: "progressive framework" },
      { name: "Angular", type: "concept", summary: "platform for building applications" },
      { name: "Svelte", type: "concept", summary: "compiler-based framework" },
    ];
    for (const e of entities) {
      await fetch(`${baseUrl}/entities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(e),
      });
    }
    const res = await fetch(`${baseUrl}/search?q=React`);
    const data = await res.json();
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.results[0].name).toBe("React");
  });

  it("GET /entities/:name returns entity detail", async () => {
    await startServer();
    await fetch(`${baseUrl}/entities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Vue", type: "concept" }),
    });
    const res = await fetch(`${baseUrl}/entities/Vue`);
    const data = await res.json();
    expect(data.found).toBe(true);
  });

  it("GET /export returns graph in mermaid format", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/export?format=mermaid`);
    const data = await res.json();
    expect(data.format).toBe("mermaid");
    expect(data.content).toContain("graph");
  });

  it("returns 404 for unknown routes", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
  });
});
