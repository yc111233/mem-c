import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadConfig,
  validateConfig,
  getRerankUrl,
  type MemcModelConfig,
} from "../host/graph-model-config.js";

describe("graph-model-config", () => {
  const configDir = join(tmpdir(), "memc-test-config");
  const configPath = join(configDir, "test-config.json");

  beforeEach(() => {
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    try {
      unlinkSync(configPath);
    } catch {
      // ignore
    }
    // Clean up env vars
    delete process.env.MEMC_CHAT_API_KEY;
    delete process.env.MEMC_EMBED_API_KEY;
    delete process.env.MEMC_RERANK_API_KEY;
    delete process.env.MEMC_CHAT_MODEL;
  });

  describe("loadConfig", () => {
    it("loads config from file", () => {
      const config: MemcModelConfig = {
        chat: {
          provider: "openai-compatible",
          baseUrl: "https://api.test.com/v1",
          apiKey: "sk-test",
          model: "test-model",
        },
        embedding: {
          provider: "openai-compatible",
          baseUrl: "https://api.test.com/v1",
          apiKey: "sk-embed",
          model: "embed-model",
          dimensions: 768,
        },
      };
      writeFileSync(configPath, JSON.stringify(config), "utf-8");

      const loaded = loadConfig(configPath);
      expect(loaded).not.toBeNull();
      expect(loaded!.chat.apiKey).toBe("sk-test");
      expect(loaded!.chat.model).toBe("test-model");
      expect(loaded!.embedding.dimensions).toBe(768);
      expect(loaded!.rerank).toBeUndefined();
    });

    it("loads config with rerank section", () => {
      const config: MemcModelConfig = {
        chat: {
          provider: "openai-compatible",
          baseUrl: "https://api.test.com/v1",
          apiKey: "sk-chat",
          model: "chat-model",
        },
        embedding: {
          provider: "openai-compatible",
          baseUrl: "https://api.test.com/v1",
          apiKey: "sk-embed",
          model: "embed-model",
        },
        rerank: {
          provider: "dashscope",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          apiKey: "sk-rerank",
          model: "gte-rerank-v2",
          topN: 5,
        },
      };
      writeFileSync(configPath, JSON.stringify(config), "utf-8");

      const loaded = loadConfig(configPath);
      expect(loaded!.rerank).toBeDefined();
      expect(loaded!.rerank!.apiKey).toBe("sk-rerank");
      expect(loaded!.rerank!.topN).toBe(5);
    });

    it("falls back to env vars when file is missing", () => {
      process.env.MEMC_CHAT_API_KEY = "sk-env-chat";
      process.env.MEMC_EMBED_API_KEY = "sk-env-embed";
      process.env.MEMC_CHAT_MODEL = "env-model";

      const loaded = loadConfig("/nonexistent/path.json");
      expect(loaded).not.toBeNull();
      expect(loaded!.chat.apiKey).toBe("sk-env-chat");
      expect(loaded!.chat.model).toBe("env-model");
      expect(loaded!.embedding.apiKey).toBe("sk-env-embed");
    });

    it("file values take priority over env vars", () => {
      process.env.MEMC_CHAT_API_KEY = "sk-env-chat";
      process.env.MEMC_CHAT_MODEL = "env-model";

      const config: MemcModelConfig = {
        chat: {
          provider: "openai-compatible",
          baseUrl: "https://api.test.com/v1",
          apiKey: "sk-file-chat",
          model: "file-model",
        },
        embedding: {
          provider: "openai-compatible",
          baseUrl: "https://api.test.com/v1",
          apiKey: "sk-embed",
          model: "embed-model",
        },
      };
      writeFileSync(configPath, JSON.stringify(config), "utf-8");

      const loaded = loadConfig(configPath);
      expect(loaded!.chat.apiKey).toBe("sk-file-chat");
      expect(loaded!.chat.model).toBe("file-model");
    });

    it("returns config with defaults when no file or env vars", () => {
      const loaded = loadConfig("/nonexistent/path.json");
      expect(loaded).not.toBeNull();
      expect(loaded!.chat.provider).toBe("openai-compatible");
      expect(loaded!.chat.model).toBe("gpt-4o-mini");
      expect(loaded!.embedding.model).toBe("text-embedding-3-small");
      expect(loaded!.rerank).toBeUndefined(); // no apiKey = no rerank
    });
  });

  describe("validateConfig", () => {
    it("passes with valid config", () => {
      const config: MemcModelConfig = {
        chat: {
          provider: "openai-compatible",
          baseUrl: "https://api.test.com/v1",
          apiKey: "sk-chat",
          model: "chat-model",
        },
        embedding: {
          provider: "openai-compatible",
          baseUrl: "https://api.test.com/v1",
          apiKey: "sk-embed",
          model: "embed-model",
        },
      };
      const result = validateConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("fails when chat.apiKey is missing", () => {
      const config: MemcModelConfig = {
        chat: {
          provider: "openai-compatible",
          baseUrl: "https://api.test.com/v1",
          apiKey: "",
          model: "chat-model",
        },
        embedding: {
          provider: "openai-compatible",
          baseUrl: "https://api.test.com/v1",
          apiKey: "sk-embed",
          model: "embed-model",
        },
      };
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("chat.apiKey is required");
    });

    it("validates rerank section when present", () => {
      const config: MemcModelConfig = {
        chat: {
          provider: "openai-compatible",
          baseUrl: "https://api.test.com/v1",
          apiKey: "sk-chat",
          model: "chat-model",
        },
        embedding: {
          provider: "openai-compatible",
          baseUrl: "https://api.test.com/v1",
          apiKey: "sk-embed",
          model: "embed-model",
        },
        rerank: {
          provider: "dashscope",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          apiKey: "",
          model: "",
        },
      };
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("rerank.apiKey is required");
      expect(result.errors).toContain("rerank.model is required");
    });
  });

  describe("getRerankUrl", () => {
    it("returns DashScope rerank URL for dashscope provider", () => {
      const config = {
        provider: "dashscope" as const,
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        apiKey: "sk-test",
        model: "gte-rerank-v2",
      };
      expect(getRerankUrl(config)).toBe(
        "https://dashscope.aliyuncs.com/api/v1/services/reranking/text-reranking/text-reranking",
      );
    });

    it("returns base URL + /rerank for openai-compatible", () => {
      const config = {
        provider: "openai-compatible" as const,
        baseUrl: "https://api.test.com/v1",
        apiKey: "sk-test",
        model: "rerank-model",
      };
      expect(getRerankUrl(config)).toBe("https://api.test.com/v1/rerank");
    });
  });
});
