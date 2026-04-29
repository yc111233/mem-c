/**
 * Adapters that convert ModelProviderConfig into MEM-C callback types.
 *
 * These bridge the gap between the unified model config and the existing
 * callback-based interfaces (LlmExtractFn, EmbedFn, etc.).
 */

import type { ModelProviderConfig, MemcModelConfig } from "./graph-model-config.js";
import type { LlmExtractFn } from "./graph-extractor.js";
import type { InferRelationFn } from "./graph-inference.js";
import type { SummarizeFn } from "./graph-community.js";
import type { EmbedFn } from "./graph-engine.js";
import {
  chatCompletion,
  embedTexts,
  rerankDocuments,
  type RerankResult,
} from "./graph-llm-client.js";

// ---------------------------------------------------------------------------
// RerankFn type (new — not in existing MEM-C types)
// ---------------------------------------------------------------------------

export type RerankFn = (
  query: string,
  documents: string[],
) => Promise<RerankResult[]>;

// ---------------------------------------------------------------------------
// Chat-based adapters
// ---------------------------------------------------------------------------

/**
 * Create an LlmExtractFn from a chat model config.
 */
export function createLlmExtractFn(config: ModelProviderConfig): LlmExtractFn {
  return async ({ systemPrompt, userPrompt }) => {
    return chatCompletion(config, [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]);
  };
}

/**
 * Create an InferRelationFn from a chat model config.
 */
export function createInferRelationFn(config: ModelProviderConfig): InferRelationFn {
  return async ({ fromName, fromType, fromSummary, toName, toType, toSummary, currentRelation }) => {
    const prompt = `Analyze this relationship and suggest a more specific relation type.

Entity A: ${fromName} (${fromType})${fromSummary ? ` — ${fromSummary}` : ""}
Entity B: ${toName} (${toType})${toSummary ? ` — ${toSummary}` : ""}
Current relation: ${currentRelation}

Return ONLY valid JSON:
{ "relation": string, "confidence": number (0-1), "reason": string }

Be specific. "works_on" is better than "relates_to".`;

    const raw = await chatCompletion(config, [
      {
        role: "system",
        content:
          "You are a relation type inference engine. Given two entities and their current generic relation, suggest a more specific relation type. Return ONLY valid JSON.",
      },
      { role: "user", content: prompt },
    ]);

    return parseInferenceResult(raw, currentRelation);
  };
}

/**
 * Create a SummarizeFn from a chat model config.
 */
export function createSummarizeFn(config: ModelProviderConfig): SummarizeFn {
  return async ({ entities, relations }) => {
    const entityList = entities
      .map((e) => `- ${e.name} (${e.type})${e.summary ? `: ${e.summary}` : ""}`)
      .join("\n");

    const relList = relations
      .map((r) => `- ${r.from} → ${r.relation} → ${r.to}`)
      .join("\n");

    const prompt = `Entities:\n${entityList}\n\nRelations:\n${relList}`;

    return chatCompletion(config, [
      {
        role: "system",
        content:
          "You are analyzing a cluster of related entities in a knowledge graph. Generate a concise label (2-5 words) that describes what this community is about. Return ONLY the label text, no explanation. Be specific, not generic.",
      },
      { role: "user", content: prompt },
    ]);
  };
}

// ---------------------------------------------------------------------------
// Embedding adapter
// ---------------------------------------------------------------------------

/**
 * Create an EmbedFn from an embedding model config.
 * Handles single-text input (as required by MEM-C's EmbedFn type).
 */
export function createEmbedFn(config: ModelProviderConfig): EmbedFn {
  // EmbedFn is synchronous (text → number[]), but the API is async.
  // We use a sync wrapper that blocks on the async call.
  // This works because Node 22+ has synchronous fetch alternatives,
  // but the simpler approach is to make the engine tolerate async embed.
  //
  // For now, return a sync function that will be called in contexts
  // where the engine has already been set up with the async variant.
  return (text: string): number[] => {
    // This is a design tension: EmbedFn is sync but HTTP is async.
    // The engine's upsertEntity calls embedFn synchronously.
    // We solve this by pre-computing embeddings in the async adapters,
    // or by making the engine support async embedFn (separate change).
    //
    // For the initial implementation, we throw to signal that
    // async embedding should be used via the engine's modelConfig path.
    throw new Error(
      "Sync EmbedFn from modelConfig not supported. Use engine's built-in async embedding or pass an external sync embedFn.",
    );
  };
}

/**
 * Create an async embedding function for use in the engine's internal path.
 * This is used by the engine when modelConfig is provided.
 */
export function createAsyncEmbedFn(config: ModelProviderConfig): (text: string) => Promise<number[]> {
  return async (text: string): Promise<number[]> => {
    const results = await embedTexts(config, [text]);
    if (results.length === 0) throw new Error("Embedding returned empty");
    return results[0]!;
  };
}

/**
 * Create an async batch embedding function.
 */
export function createBatchEmbedFn(
  config: ModelProviderConfig,
): (texts: string[]) => Promise<number[][]> {
  return (texts: string[]) => embedTexts(config, texts);
}

// ---------------------------------------------------------------------------
// Rerank adapter
// ---------------------------------------------------------------------------

/**
 * Create a RerankFn from a rerank model config.
 */
export function createRerankFn(config: ModelProviderConfig): RerankFn {
  return (query: string, documents: string[]) =>
    rerankDocuments(config, query, documents);
}

// ---------------------------------------------------------------------------
// Convenience: create all adapters from a full config
// ---------------------------------------------------------------------------

export type ModelAdapters = {
  llmExtract: LlmExtractFn;
  inferRelation: InferRelationFn;
  summarize: SummarizeFn;
  rerank?: RerankFn;
  asyncEmbed: (text: string) => Promise<number[]>;
};

/**
 * Create all adapter functions from a MemcModelConfig.
 */
export function createAllAdapters(config: MemcModelConfig): ModelAdapters {
  return {
    llmExtract: createLlmExtractFn(config.chat),
    inferRelation: createInferRelationFn(config.chat),
    summarize: createSummarizeFn(config.chat),
    rerank: config.rerank ? createRerankFn(config.rerank) : undefined,
    asyncEmbed: createAsyncEmbedFn(config.embedding),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseInferenceResult(
  raw: string,
  fallbackRelation: string,
): { relation: string; confidence: number; reason?: string } {
  let jsonStr = raw.trim();

  // Strip markdown code blocks
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1]!.trim();
  }

  const firstBrace = jsonStr.indexOf("{");
  const lastBrace = jsonStr.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
  }

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    return {
      relation: typeof parsed.relation === "string" ? parsed.relation : fallbackRelation,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  } catch {
    return { relation: fallbackRelation, confidence: 0 };
  }
}
