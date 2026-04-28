import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import { importDocument, smartChunk, batchChatImport, type DocumentParser } from "../host/graph-import.js";
import { createTestDb } from "./test-helpers.js";

describe("smartChunk", () => {
  it("returns single chunk for short text", () => {
    const chunks = smartChunk("Hello world", 1000);
    expect(chunks).toEqual(["Hello world"]);
  });

  it("splits on paragraph break", () => {
    const text = "First paragraph content here.\n\nSecond paragraph content here.";
    const chunks = smartChunk(text, 30);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toContain("First");
    expect(chunks[1]).toContain("Second");
  });

  it("splits on sentence boundary", () => {
    const text = "This is sentence one. This is sentence two. This is sentence three.";
    const chunks = smartChunk(text, 35);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("hard cuts when no good boundary", () => {
    const text = "a".repeat(200);
    const chunks = smartChunk(text, 50);
    expect(chunks.length).toBe(4);
  });

  it("preserves all content", () => {
    const text = "Paragraph one.\n\nParagraph two.\n\nParagraph three.";
    const chunks = smartChunk(text, 20);
    const reconstructed = chunks.join(" ");
    expect(reconstructed).toContain("Paragraph one");
    expect(reconstructed).toContain("Paragraph two");
    expect(reconstructed).toContain("Paragraph three");
  });
});

describe("importDocument", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  it("processes a simple document", async () => {
    const mockExtract = async () =>
      JSON.stringify({
        entities: [{ name: "TestEntity", type: "concept", summary: "from doc", confidence: 0.9 }],
        relations: [],
        invalidations: [],
      });

    const parser: DocumentParser = (content) => [{ index: 0, content }];

    const result = await importDocument(engine, {
      content: "This is a test document about TestEntity and how it relates to other concepts in the knowledge graph.",
      parser,
      llmExtract: mockExtract,
    });

    expect(result.chunksProcessed).toBe(1);
    expect(result.entitiesCreated).toBeGreaterThanOrEqual(1);
  });

  it("handles cross-chunk dedup", async () => {
    let callCount = 0;
    const mockExtract = async () => {
      callCount++;
      return JSON.stringify({
        entities: [{ name: "SharedEntity", type: "concept", summary: `chunk ${callCount}`, confidence: 0.9 }],
        relations: [],
        invalidations: [],
      });
    };

    const parser: DocumentParser = (content) => {
      const mid = Math.floor(content.length / 2);
      return [
        { index: 0, content: content.slice(0, mid) },
        { index: 1, content: content.slice(mid) },
      ];
    };

    const result = await importDocument(engine, {
      content: "A".repeat(200) + "\n\n" + "B".repeat(200),
      parser,
      llmExtract: mockExtract,
      chunkSize: 50,
    });

    const entities = engine.findEntities({ name: "SharedEntity" });
    expect(entities.length).toBe(1);
  });

  it("returns empty for empty content", async () => {
    const mockExtract = async () =>
      JSON.stringify({ entities: [], relations: [], invalidations: [] });
    const parser: DocumentParser = () => [];

    const result = await importDocument(engine, {
      content: "",
      parser,
      llmExtract: mockExtract,
    });

    expect(result.chunksProcessed).toBe(0);
  });
});

describe("batchChatImport", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  it("imports multiple chat sessions", async () => {
    const mockExtract = async () =>
      JSON.stringify({
        entities: [{ name: "ChatEntity", type: "concept", summary: "from chat", confidence: 0.9 }],
        relations: [],
        invalidations: [],
      });

    const sessions = [
      [{ role: "user" as const, content: "I really love using React for building frontend applications with components" }],
      [{ role: "user" as const, content: "Vue is also a great framework for building modern web applications" }],
    ];

    const result = await batchChatImport(engine, sessions, {
      llmExtract: mockExtract,
    });

    expect(result.sessionsProcessed).toBe(2);
    expect(result.totalEntitiesCreated).toBeGreaterThanOrEqual(1);
  });

  it("handles empty sessions", async () => {
    const mockExtract = async () =>
      JSON.stringify({ entities: [], relations: [], invalidations: [] });

    const result = await batchChatImport(engine, [], {
      llmExtract: mockExtract,
    });

    expect(result.sessionsProcessed).toBe(0);
  });
});
