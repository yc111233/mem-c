import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import {
  buildExtractionUserPrompt,
  extractAndMerge,
  EXTRACTION_SYSTEM_PROMPT,
  type LlmExtractFn,
} from "../host/graph-extractor.js";
import { ensureGraphSchema } from "../host/graph-schema.js";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureGraphSchema({ db, ftsEnabled: true });
  return db;
}

describe("graph-extractor", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("buildExtractionUserPrompt", () => {
    it("includes transcript in the prompt", () => {
      const prompt = buildExtractionUserPrompt("Hello world", ["React"]);
      expect(prompt).toContain("Hello world");
      expect(prompt).toContain("React");
    });

    it("works without existing entity names", () => {
      const prompt = buildExtractionUserPrompt("Hello world");
      expect(prompt).toContain("Hello world");
    });
  });

  describe("extractAndMerge", () => {
    it("creates entities and edges from LLM output", async () => {
      const mockLlm: LlmExtractFn = vi.fn().mockResolvedValue(
        JSON.stringify({
          entities: [
            { name: "React", type: "concept", summary: "A UI library", confidence: 0.9 },
            { name: "Hooks", type: "concept", summary: "React feature", confidence: 0.8 },
          ],
          relations: [
            {
              fromName: "React",
              fromType: "concept",
              toName: "Hooks",
              toType: "concept",
              relation: "has_feature",
            },
          ],
          contradictions: [],
        }),
      );

      const result = await extractAndMerge({
        engine,
        transcript: "The user discussed React hooks in detail, specifically useState and useEffect.",
        sessionKey: "session-1",
        llmExtract: mockLlm,
      });

      expect(result.entitiesCreated).toBe(2);
      expect(result.edgesCreated).toBe(1);
      expect(result.episodeRecorded).toBe(true);
      expect(result.assertionsRecorded).toBe(2);
      expect(result.supersessionProposals).toBe(0);
      expect(result.errors).toHaveLength(0);

      // Verify entities in DB
      const entities = engine.findEntities({ type: "concept" });
      expect(entities).toHaveLength(2);
    });

    it("creates supersession proposals for contradictions instead of direct invalidation", async () => {
      // Pre-create an entity that will be contradicted
      engine.upsertEntity({ name: "Old API", type: "concept", summary: "v1" });

      const mockLlm: LlmExtractFn = vi.fn().mockResolvedValue(
        JSON.stringify({
          entities: [
            { name: "New API", type: "concept", summary: "v2 replacement", confidence: 1.0 },
          ],
          relations: [],
          contradictions: [
            {
              existingEntityName: "Old API",
              existingEntityType: "concept",
              newInfo: "Old API has been replaced by New API v2",
              reason: "replaced by New API",
            },
          ],
        }),
      );

      const result = await extractAndMerge({
        engine,
        transcript: "We migrated from Old API to New API because of performance issues with the old version.",
        sessionKey: "session-1",
        llmExtract: mockLlm,
      });

      expect(result.supersessionProposals).toBe(1);
      expect(result.entitiesCreated).toBe(1);

      // Old API should still be active (not directly invalidated)
      const active = engine.findEntities({ name: "Old API", activeOnly: true });
      expect(active).toHaveLength(1);

      // A pending supersession proposal should exist
      const proposals = engine.getPendingProposals({ targetEntityId: active[0]!.id });
      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.new_assertion_text).toContain("New API");
    });

    it("skips short transcripts", async () => {
      const mockLlm: LlmExtractFn = vi.fn();

      const result = await extractAndMerge({
        engine,
        transcript: "hi",
        sessionKey: "session-1",
        llmExtract: mockLlm,
      });

      expect(result.entitiesCreated).toBe(0);
      expect(mockLlm).not.toHaveBeenCalled();
    });

    it("handles LLM failure gracefully", async () => {
      const mockLlm: LlmExtractFn = vi.fn().mockRejectedValue(new Error("API error"));

      const result = await extractAndMerge({
        engine,
        transcript: "A meaningful conversation about software architecture and design patterns.",
        sessionKey: "session-1",
        llmExtract: mockLlm,
      });

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("API error");
    });

    it("handles markdown-wrapped JSON from LLM", async () => {
      const mockLlm: LlmExtractFn = vi.fn().mockResolvedValue(
        '```json\n{"entities": [{"name": "Test", "type": "concept", "summary": "A test entity", "confidence": 1.0}], "relations": [], "contradictions": []}\n```',
      );

      const result = await extractAndMerge({
        engine,
        transcript: "A detailed discussion about testing strategies and best practices for unit tests.",
        sessionKey: "session-1",
        llmExtract: mockLlm,
      });

      expect(result.entitiesCreated).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it("deduplicates existing entities via upsert", async () => {
      engine.upsertEntity({ name: "React", type: "concept", summary: "old summary" });

      const mockLlm: LlmExtractFn = vi.fn().mockResolvedValue(
        JSON.stringify({
          entities: [
            { name: "React", type: "concept", summary: "updated summary", confidence: 1.0 },
          ],
          relations: [],
          contradictions: [],
        }),
      );

      const result = await extractAndMerge({
        engine,
        transcript: "A detailed conversation about React patterns and the latest features in React 19.",
        sessionKey: "session-1",
        llmExtract: mockLlm,
        existingEntityNames: ["React"],
      });

      expect(result.entitiesUpdated).toBe(1);
      expect(result.entitiesCreated).toBe(0);

      const entities = engine.findEntities({ name: "React" });
      expect(entities).toHaveLength(1);
      expect(entities[0]!.summary).toBe("updated summary");
    });
  });
});
