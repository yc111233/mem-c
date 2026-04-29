import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createLlmExtractFn,
  createInferRelationFn,
  createSummarizeFn,
  createRerankFn,
  createAsyncEmbedFn,
  createAllAdapters,
} from "../host/graph-model-adapters.js";
import type { ModelProviderConfig, MemcModelConfig } from "../host/graph-model-config.js";

// Mock the LLM client module
vi.mock("../host/graph-llm-client.js", () => ({
  chatCompletion: vi.fn(async () =>
    JSON.stringify({
      entities: [
        { name: "TestEntity", type: "concept", summary: "A test entity", confidence: 0.9 },
      ],
      relations: [],
      invalidations: [],
    }),
  ),
  embedTexts: vi.fn(async () => [[0.1, 0.2, 0.3]]),
  rerankDocuments: vi.fn(async () => [
    { index: 1, score: 0.95, document: "doc2" },
    { index: 0, score: 0.8, document: "doc1" },
  ]),
}));

const mockConfig: ModelProviderConfig = {
  provider: "openai-compatible",
  baseUrl: "https://api.test.com/v1",
  apiKey: "sk-test",
  model: "test-model",
};

const fullConfig: MemcModelConfig = {
  chat: mockConfig,
  embedding: { ...mockConfig, model: "embed-model", dimensions: 768 },
  rerank: { ...mockConfig, model: "rerank-model", topN: 5 },
};

describe("graph-model-adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createLlmExtractFn", () => {
    it("returns a function that calls chatCompletion", async () => {
      const fn = createLlmExtractFn(mockConfig);
      const result = await fn({
        systemPrompt: "You are a test",
        userPrompt: "Extract from this text",
      });

      expect(typeof result).toBe("string");
      expect(result).toContain("TestEntity");
    });
  });

  describe("createInferRelationFn", () => {
    it("returns a function that parses inference JSON", async () => {
      // Override mock for this test
      const { chatCompletion } = await import("../host/graph-llm-client.js");
      vi.mocked(chatCompletion).mockResolvedValueOnce(
        JSON.stringify({ relation: "works_on", confidence: 0.85, reason: "test" }),
      );

      const fn = createInferRelationFn(mockConfig);
      const result = await fn({
        fromName: "Alice",
        fromType: "person",
        fromSummary: "Engineer",
        toName: "ProjectX",
        toType: "project",
        toSummary: "A project",
        currentRelation: "relates_to",
      });

      expect(result.relation).toBe("works_on");
      expect(result.confidence).toBe(0.85);
      expect(result.reason).toBe("test");
    });

    it("returns fallback on invalid JSON", async () => {
      const { chatCompletion } = await import("../host/graph-llm-client.js");
      vi.mocked(chatCompletion).mockResolvedValueOnce("not json");

      const fn = createInferRelationFn(mockConfig);
      const result = await fn({
        fromName: "Alice",
        fromType: "person",
        fromSummary: null,
        toName: "Bob",
        toType: "person",
        toSummary: null,
        currentRelation: "relates_to",
      });

      expect(result.relation).toBe("relates_to");
      expect(result.confidence).toBe(0);
    });
  });

  describe("createSummarizeFn", () => {
    it("returns a function that calls chatCompletion", async () => {
      const { chatCompletion } = await import("../host/graph-llm-client.js");
      vi.mocked(chatCompletion).mockResolvedValueOnce("Frontend Tech");

      const fn = createSummarizeFn(mockConfig);
      const result = await fn({
        entities: [
          { name: "React", type: "concept", summary: "UI library" },
          { name: "Vue", type: "concept", summary: "Another UI library" },
        ],
        relations: [{ from: "React", to: "Vue", relation: "relates_to" }],
      });

      expect(result).toBe("Frontend Tech");
    });
  });

  describe("createAsyncEmbedFn", () => {
    it("returns a function that calls embedTexts", async () => {
      const fn = createAsyncEmbedFn(mockConfig);
      const result = await fn("test text");

      expect(result).toEqual([0.1, 0.2, 0.3]);
    });
  });

  describe("createRerankFn", () => {
    it("returns a function that calls rerankDocuments", async () => {
      const fn = createRerankFn(mockConfig);
      const result = await fn("test query", ["doc1", "doc2"]);

      expect(result).toHaveLength(2);
      expect(result[0]!.index).toBe(1);
      expect(result[0]!.score).toBe(0.95);
    });
  });

  describe("createAllAdapters", () => {
    it("creates all adapters from config", () => {
      const adapters = createAllAdapters(fullConfig);

      expect(adapters.llmExtract).toBeTypeOf("function");
      expect(adapters.inferRelation).toBeTypeOf("function");
      expect(adapters.summarize).toBeTypeOf("function");
      expect(adapters.rerank).toBeTypeOf("function");
      expect(adapters.asyncEmbed).toBeTypeOf("function");
    });

    it("omits rerank when not configured", () => {
      const configNoRerank: MemcModelConfig = {
        chat: mockConfig,
        embedding: { ...mockConfig, model: "embed-model" },
      };
      const adapters = createAllAdapters(configNoRerank);

      expect(adapters.rerank).toBeUndefined();
    });
  });
});
