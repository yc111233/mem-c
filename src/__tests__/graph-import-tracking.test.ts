import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import { createTestDb } from "./test-helpers.js";
import {
  importDocument,
  createImportSession,
  updateImportSession,
  getImportSession,
  listImportSessions,
  type DocumentParser,
} from "../host/graph-import.js";

describe("import session tracking", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  it("creates and retrieves import session", () => {
    const session = createImportSession(db, "markdown", "/path/to/doc.md");
    expect(session.id).toBeDefined();
    expect(session.sourceType).toBe("markdown");
    expect(session.sourcePath).toBe("/path/to/doc.md");
    expect(session.status).toBe("pending");
    expect(session.totalChunks).toBe(0);
    expect(session.processedChunks).toBe(0);
    expect(session.createdAt).toBeGreaterThan(0);

    const retrieved = getImportSession(db, session.id);
    expect(retrieved!.id).toBe(session.id);
    expect(retrieved!.sourceType).toBe("markdown");
  });

  it("creates session without source path", () => {
    const session = createImportSession(db, "pdf");
    expect(session.sourcePath).toBeNull();
    expect(session.sourceType).toBe("pdf");
  });

  it("updates session progress", () => {
    const session = createImportSession(db, "markdown");
    updateImportSession(db, session.id, {
      status: "in_progress",
      totalChunks: 10,
      processedChunks: 5,
      entitiesCreated: 3,
    });

    const updated = getImportSession(db, session.id)!;
    expect(updated.status).toBe("in_progress");
    expect(updated.totalChunks).toBe(10);
    expect(updated.processedChunks).toBe(5);
    expect(updated.entitiesCreated).toBe(3);
  });

  it("sets completedAt when status is completed", () => {
    const session = createImportSession(db, "markdown");
    updateImportSession(db, session.id, { status: "completed" });

    const updated = getImportSession(db, session.id)!;
    expect(updated.status).toBe("completed");
    expect(updated.completedAt).toBeGreaterThan(0);
  });

  it("lists import sessions", () => {
    createImportSession(db, "pdf");
    createImportSession(db, "feishu");

    const sessions = listImportSessions(db);
    expect(sessions.length).toBe(2);
    expect(sessions.map((s) => s.sourceType).sort()).toEqual(["feishu", "pdf"]);
  });

  it("returns null for non-existent session", () => {
    const result = getImportSession(db, "non-existent-id");
    expect(result).toBeNull();
  });

  it("tracks progress through importDocument", async () => {
    const mockExtract = async () =>
      JSON.stringify({
        entities: [{ name: "E", type: "concept", summary: "test", confidence: 0.9 }],
        relations: [],
        invalidations: [],
      });

    const parser: DocumentParser = (content) => [{ index: 0, content }];

    const result = await importDocument(engine, {
      content: "Test document content for tracking.",
      parser,
      llmExtract: mockExtract,
      sourceType: "test",
    });

    expect(result.sessionId).toBeDefined();
    const session = getImportSession(db, result.sessionId);
    expect(session).not.toBeNull();
    expect(session!.status).toBe("completed");
    expect(session!.processedChunks).toBe(1);
    expect(session!.totalChunks).toBe(1);
    expect(session!.sourceType).toBe("test");
  });

  it("reuses existing import session ID", async () => {
    const existing = createImportSession(db, "markdown", "/existing.md");

    const mockExtract = async () =>
      JSON.stringify({
        entities: [{ name: "R", type: "concept", summary: "reuse", confidence: 0.9 }],
        relations: [],
        invalidations: [],
      });

    const parser: DocumentParser = (content) => [{ index: 0, content }];

    const result = await importDocument(engine, {
      content: "Reused session content.",
      parser,
      llmExtract: mockExtract,
      importSessionId: existing.id,
    });

    expect(result.sessionId).toBe(existing.id);
    const session = getImportSession(db, existing.id)!;
    expect(session.status).toBe("completed");
    expect(session.sourceType).toBe("markdown");
    expect(session.sourcePath).toBe("/existing.md");
  });

  it("tracks empty document import", async () => {
    const mockExtract = async () =>
      JSON.stringify({ entities: [], relations: [], invalidations: [] });

    const parser: DocumentParser = () => [];

    const result = await importDocument(engine, {
      content: "",
      parser,
      llmExtract: mockExtract,
      sourceType: "empty",
    });

    expect(result.sessionId).toBeDefined();
    const session = getImportSession(db, result.sessionId)!;
    expect(session.status).toBe("completed");
    expect(session.processedChunks).toBe(0);
  });
});
