/**
 * Unified model configuration for MEM-C.
 *
 * Supports OpenAI-compatible and DashScope providers.
 * Config file takes priority over environment variables.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelProvider = "openai-compatible" | "dashscope";

export type ModelProviderConfig = {
  provider: ModelProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Embedding dimensions (only for embedding config). */
  dimensions?: number;
  /** Rerank top_n (only for rerank config). */
  topN?: number;
  /** Request timeout in ms. Default varies by type. */
  timeoutMs?: number;
};

export type MemcModelConfig = {
  chat: ModelProviderConfig;
  embedding: ModelProviderConfig;
  rerank?: ModelProviderConfig;
};

// ---------------------------------------------------------------------------
// Default base URLs
// ---------------------------------------------------------------------------

const DEFAULT_URLS: Record<ModelProvider, string> = {
  "openai-compatible": "https://api.openai.com/v1",
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
};

const DASHSCOPE_RERANK_URL =
  "https://dashscope.aliyuncs.com/api/v1/services/reranking/text-reranking/text-reranking";

// ---------------------------------------------------------------------------
// Load config
// ---------------------------------------------------------------------------

/**
 * Load model configuration from a JSON file, with environment variable fallback.
 *
 * Priority: file > environment variables > defaults.
 *
 * Search order for config file:
 * 1. Explicit `configPath` argument
 * 2. `MEMC_CONFIG_PATH` environment variable
 * 3. `./mem-c.config.json` in cwd
 */
export function loadConfig(configPath?: string): MemcModelConfig | null {
  const filePath =
    configPath ??
    process.env.MEMC_CONFIG_PATH ??
    resolve(process.cwd(), "mem-c.config.json");

  let fileConfig: Partial<MemcModelConfig> = {};
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      fileConfig = JSON.parse(raw) as Partial<MemcModelConfig>;
    } catch {
      // File exists but is malformed — fall through to env vars
    }
  }

  const chat = mergeConfig("chat", fileConfig.chat, {
    apiKeyEnv: "MEMC_CHAT_API_KEY",
    baseUrlEnv: "MEMC_CHAT_BASE_URL",
    modelEnv: "MEMC_CHAT_MODEL",
    defaultBaseUrl: DEFAULT_URLS["openai-compatible"],
    defaultModel: "gpt-4o-mini",
  });

  const embedding = mergeConfig("embedding", fileConfig.embedding, {
    apiKeyEnv: "MEMC_EMBED_API_KEY",
    baseUrlEnv: "MEMC_EMBED_BASE_URL",
    modelEnv: "MEMC_EMBED_MODEL",
    dimensionsEnv: "MEMC_EMBED_DIMENSIONS",
    defaultBaseUrl: DEFAULT_URLS["openai-compatible"],
    defaultModel: "text-embedding-3-small",
  });

  const rerank = mergeConfig("rerank", fileConfig.rerank, {
    apiKeyEnv: "MEMC_RERANK_API_KEY",
    modelEnv: "MEMC_RERANK_MODEL",
    topNEnv: "MEMC_RERANK_TOP_N",
    defaultBaseUrl: DASHSCOPE_RERANK_URL,
    defaultModel: "gte-rerank-v2",
    defaultProvider: "dashscope" as ModelProvider,
  });

  const config: MemcModelConfig = { chat, embedding };
  if (rerank.apiKey) {
    config.rerank = rerank;
  }

  return config;
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

export type ConfigValidation = {
  valid: boolean;
  errors: string[];
};

/**
 * Validate that required fields are present.
 * Returns errors for each missing field.
 */
export function validateConfig(config: MemcModelConfig): ConfigValidation {
  const errors: string[] = [];

  if (!config.chat.apiKey) errors.push("chat.apiKey is required");
  if (!config.chat.model) errors.push("chat.model is required");
  if (!config.embedding.apiKey) errors.push("embedding.apiKey is required");
  if (!config.embedding.model) errors.push("embedding.model is required");

  if (config.rerank) {
    if (!config.rerank.apiKey) errors.push("rerank.apiKey is required");
    if (!config.rerank.model) errors.push("rerank.model is required");
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Rerank URL helper
// ---------------------------------------------------------------------------

/**
 * Get the full rerank API URL for a given provider config.
 * DashScope rerank uses a different endpoint than its OpenAI-compatible mode.
 */
export function getRerankUrl(config: ModelProviderConfig): string {
  if (config.provider === "dashscope") {
    return DASHSCOPE_RERANK_URL;
  }
  // OpenAI-compatible doesn't have a standard rerank endpoint
  return `${config.baseUrl}/rerank`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type MergeOpts = {
  apiKeyEnv: string;
  baseUrlEnv?: string;
  modelEnv?: string;
  dimensionsEnv?: string;
  topNEnv?: string;
  defaultBaseUrl: string;
  defaultModel: string;
  defaultProvider?: ModelProvider;
};

function mergeConfig(
  _section: string,
  fileSection: ModelProviderConfig | undefined,
  opts: MergeOpts,
): ModelProviderConfig {
  const provider: ModelProvider =
    fileSection?.provider ??
    opts.defaultProvider ??
    "openai-compatible";

  const baseUrl =
    fileSection?.baseUrl ??
    (opts.baseUrlEnv ? process.env[opts.baseUrlEnv] : undefined) ??
    opts.defaultBaseUrl;

  const apiKey =
    fileSection?.apiKey ??
    (opts.apiKeyEnv ? process.env[opts.apiKeyEnv] : undefined) ??
    "";

  const model =
    fileSection?.model ??
    (opts.modelEnv ? process.env[opts.modelEnv] : undefined) ??
    opts.defaultModel;

  const dimensions =
    fileSection?.dimensions ??
    (opts.dimensionsEnv
      ? Number(process.env[opts.dimensionsEnv])
      : undefined);

  const topN =
    fileSection?.topN ??
    (opts.topNEnv ? Number(process.env[opts.topNEnv]) : undefined);

  const timeoutMs = fileSection?.timeoutMs;

  const config: ModelProviderConfig = {
    provider,
    baseUrl,
    apiKey,
    model,
  };
  if (dimensions !== undefined && !Number.isNaN(dimensions)) {
    config.dimensions = dimensions;
  }
  if (topN !== undefined && !Number.isNaN(topN)) {
    config.topN = topN;
  }
  if (timeoutMs !== undefined) {
    config.timeoutMs = timeoutMs;
  }

  return config;
}
