/**
 * Built-in HTTP client for LLM API calls.
 *
 * Supports OpenAI-compatible and DashScope providers.
 * Uses node:fetch (zero external dependencies).
 */

import type { ModelProviderConfig } from "./graph-model-config.js";
import { getRerankUrl } from "./graph-model-config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type RerankResult = {
  index: number;
  score: number;
  document?: string;
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_CHAT = 30_000;
const DEFAULT_TIMEOUT_EMBED = 10_000;
const DEFAULT_TIMEOUT_RERANK = 15_000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

// ---------------------------------------------------------------------------
// Chat completion
// ---------------------------------------------------------------------------

/**
 * Call a chat completion API (OpenAI-compatible format).
 */
export async function chatCompletion(
  config: ModelProviderConfig,
  messages: ChatMessage[],
): Promise<string> {
  const url = `${config.baseUrl}/chat/completions`;
  const body = {
    model: config.model,
    messages,
    temperature: 0.1,
  };

  const data = await fetchJson<Record<string, unknown>>(
    url,
    body,
    config.apiKey,
    config.timeoutMs ?? DEFAULT_TIMEOUT_CHAT,
  );

  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  if (!choices || choices.length === 0) {
    throw new Error("LLM returned empty choices");
  }

  const message = choices[0]!.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content !== "string") {
    throw new Error("LLM returned unexpected message format");
  }

  return content;
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

/**
 * Generate embeddings for one or more texts (OpenAI-compatible format).
 */
export async function embedTexts(
  config: ModelProviderConfig,
  texts: string[],
): Promise<number[][]> {
  const url = `${config.baseUrl}/embeddings`;
  const body: Record<string, unknown> = {
    model: config.model,
    input: texts,
  };
  if (config.dimensions) {
    body.dimensions = config.dimensions;
  }

  const data = await fetchJson<Record<string, unknown>>(
    url,
    body,
    config.apiKey,
    config.timeoutMs ?? DEFAULT_TIMEOUT_EMBED,
  );

  const items = data.data as Array<Record<string, unknown>> | undefined;
  if (!items || items.length === 0) {
    throw new Error("Embedding API returned empty data");
  }

  return items.map((item) => {
    const embedding = item.embedding;
    if (!Array.isArray(embedding)) {
      throw new Error("Embedding API returned unexpected format");
    }
    return embedding as number[];
  });
}

// ---------------------------------------------------------------------------
// Rerank (DashScope format)
// ---------------------------------------------------------------------------

/**
 * Rerank documents by relevance to a query.
 * Uses DashScope's rerank API format.
 */
export async function rerankDocuments(
  config: ModelProviderConfig,
  query: string,
  documents: string[],
): Promise<RerankResult[]> {
  const url = getRerankUrl(config);
  const body = {
    model: config.model,
    input: { query, documents },
    parameters: {
      return_documents: true,
      top_n: config.topN ?? documents.length,
    },
  };

  const data = await fetchJson<Record<string, unknown>>(
    url,
    body,
    config.apiKey,
    config.timeoutMs ?? DEFAULT_TIMEOUT_RERANK,
  );

  // DashScope response: { output: { results: [...] } }
  const output = data.output as Record<string, unknown> | undefined;
  const results = output?.results as Array<Record<string, unknown>> | undefined;

  if (!results) {
    throw new Error("Rerank API returned unexpected format");
  }

  return results.map((r) => ({
    index: r.index as number,
    score: r.relevance_score as number,
    document:
      typeof r.document === "object" && r.document !== null
        ? (r.document as Record<string, string>).text
        : undefined,
  }));
}

// ---------------------------------------------------------------------------
// HTTP helper with retry
// ---------------------------------------------------------------------------

async function fetchJson<T>(
  url: string,
  body: unknown,
  apiKey: string,
  timeoutMs: number,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "unknown");
        const err = new Error(
          `API error ${resp.status}: ${errText.slice(0, 500)}`,
        );
        // Don't retry client errors (4xx)
        if (resp.status >= 400 && resp.status < 500) {
          throw err;
        }
        lastError = err;
        continue;
      }

      return (await resp.json()) as T;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        lastError = new Error(`API timeout after ${timeoutMs}ms`);
      } else if (err instanceof Error && err.message.startsWith("API error 4")) {
        throw err; // Don't retry 4xx
      } else {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  throw lastError ?? new Error("API call failed after retries");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
