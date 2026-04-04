/**
 * Automatic knowledge extraction from conversation transcripts.
 *
 * Triggered during memory-flush (token threshold) and session end.
 * Uses LLM to extract structured entities and relationships from dialogue,
 * then merges them into the memory graph with deduplication and conflict resolution.
 */

import type { MemoryGraphEngine, EntityInput, EdgeInput, EpisodeInput } from "./graph-engine.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Raw extraction result from LLM.
 * The LLM returns JSON conforming to this schema.
 */
export type ExtractionResult = {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  /** Entity names that should be invalidated (contradicted by new info). */
  invalidations: Array<{ name: string; type: string; reason: string }>;
};

export type ExtractedEntity = {
  name: string;
  type: string;
  summary: string;
  confidence?: number;
};

export type ExtractedRelation = {
  fromName: string;
  fromType: string;
  toName: string;
  toType: string;
  relation: string;
};

/**
 * Callback type for the LLM extraction call.
 * The memory graph module does not import any LLM SDK directly;
 * the caller provides this function.
 */
export type LlmExtractFn = (params: {
  systemPrompt: string;
  userPrompt: string;
}) => Promise<string>;

// ---------------------------------------------------------------------------
// Extraction prompt
// ---------------------------------------------------------------------------

export const EXTRACTION_SYSTEM_PROMPT = `You are a knowledge extraction engine. Given a conversation transcript, extract structured entities and relationships.

Return ONLY valid JSON matching this schema:
{
  "entities": [
    { "name": string, "type": string, "summary": string, "confidence": number }
  ],
  "relations": [
    { "fromName": string, "fromType": string, "toName": string, "toType": string, "relation": string }
  ],
  "invalidations": [
    { "name": string, "type": string, "reason": string }
  ]
}

Entity types: user, project, concept, file, decision, feedback, tool, preference
Relation types: works_on, decided, prefers, knows, uses, created, depends_on, relates_to, replaced_by

Rules:
- Extract only facts explicitly stated or strongly implied in the conversation.
- Set confidence between 0.5 (inferred) and 1.0 (explicitly stated).
- If a new fact contradicts a previously known fact, add the old fact to invalidations.
- Keep entity names concise and consistent (prefer existing names if you know them).
- Do NOT extract trivial or ephemeral information (greetings, filler).
- Return empty arrays if nothing meaningful can be extracted.`;

export function buildExtractionUserPrompt(
  transcript: string,
  existingEntityNames?: string[],
): string {
  const context = existingEntityNames?.length
    ? `\nKnown entities (prefer these names for deduplication): ${existingEntityNames.join(", ")}\n`
    : "";
  return `${context}\nConversation transcript:\n\`\`\`\n${transcript}\n\`\`\``;
}

// ---------------------------------------------------------------------------
// Extract and merge
// ---------------------------------------------------------------------------

export type ExtractAndMergeResult = {
  entitiesCreated: number;
  entitiesUpdated: number;
  edgesCreated: number;
  invalidated: number;
  episodeRecorded: boolean;
  errors: string[];
};

/**
 * Run extraction on a transcript and merge results into the graph.
 *
 * This is the main entry point called during memory-flush.
 */
export async function extractAndMerge(params: {
  engine: MemoryGraphEngine;
  transcript: string;
  sessionKey: string;
  turnIndex?: number;
  llmExtract: LlmExtractFn;
  existingEntityNames?: string[];
}): Promise<ExtractAndMergeResult> {
  const result: ExtractAndMergeResult = {
    entitiesCreated: 0,
    entitiesUpdated: 0,
    edgesCreated: 0,
    invalidated: 0,
    episodeRecorded: false,
    errors: [],
  };

  // Skip if transcript is too short to be meaningful
  if (params.transcript.trim().length < 50) {
    return result;
  }

  // Call LLM for extraction
  let extraction: ExtractionResult;
  try {
    const raw = await params.llmExtract({
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      userPrompt: buildExtractionUserPrompt(params.transcript, params.existingEntityNames),
    });
    extraction = parseExtractionResult(raw);
  } catch (err) {
    result.errors.push(`LLM extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  // Process invalidations first
  for (const inv of extraction.invalidations) {
    try {
      const matches = params.engine.findEntities({
        name: inv.name,
        type: inv.type,
        activeOnly: true,
        limit: 1,
      });
      if (matches.length > 0) {
        params.engine.invalidateEntity(matches[0]!.id, inv.reason);
        result.invalidated++;
      }
    } catch (err) {
      result.errors.push(`Invalidation failed for "${inv.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Upsert entities
  const nameToId = new Map<string, string>();
  for (const extracted of extraction.entities) {
    try {
      const existing = params.engine.findEntities({
        name: extracted.name,
        type: extracted.type,
        activeOnly: true,
        limit: 1,
      });

      const entity = params.engine.upsertEntity({
        name: extracted.name,
        type: extracted.type,
        summary: extracted.summary,
        confidence: extracted.confidence,
        source: "auto",
      });

      nameToId.set(`${extracted.name}:${extracted.type}`, entity.id);

      if (existing.length > 0) {
        result.entitiesUpdated++;
      } else {
        result.entitiesCreated++;
      }
    } catch (err) {
      result.errors.push(`Entity upsert failed for "${extracted.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Create edges
  for (const rel of extraction.relations) {
    try {
      const fromId = nameToId.get(`${rel.fromName}:${rel.fromType}`);
      const toId = nameToId.get(`${rel.toName}:${rel.toType}`);

      if (!fromId || !toId) {
        // Ensure both entities exist
        const from = params.engine.upsertEntity({
          name: rel.fromName,
          type: rel.fromType,
          source: "auto",
        });
        const to = params.engine.upsertEntity({
          name: rel.toName,
          type: rel.toType,
          source: "auto",
        });
        params.engine.addEdge({
          fromId: from.id,
          toId: to.id,
          relation: rel.relation,
        });
      } else {
        params.engine.addEdge({
          fromId,
          toId,
          relation: rel.relation,
        });
      }
      result.edgesCreated++;
    } catch (err) {
      result.errors.push(`Edge creation failed for "${rel.fromName}" -> "${rel.toName}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Record episode
  try {
    const entityIds = Array.from(nameToId.values());
    params.engine.recordEpisode({
      sessionKey: params.sessionKey,
      turnIndex: params.turnIndex,
      content: params.transcript.length > 2000
        ? params.transcript.slice(0, 2000) + "..."
        : params.transcript,
      extractedEntityIds: entityIds,
    });
    result.episodeRecorded = true;
  } catch (err) {
    result.errors.push(`Episode recording failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// JSON parsing with error recovery
// ---------------------------------------------------------------------------

function parseExtractionResult(raw: string): ExtractionResult {
  // Try to extract JSON from the response (LLM may wrap in markdown code blocks)
  let jsonStr = raw.trim();

  // Strip markdown code blocks
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1]!.trim();
  }

  // Try to find JSON object boundaries
  const firstBrace = jsonStr.indexOf("{");
  const lastBrace = jsonStr.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
  }

  const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

  return {
    entities: Array.isArray(parsed.entities) ? (parsed.entities as ExtractedEntity[]) : [],
    relations: Array.isArray(parsed.relations) ? (parsed.relations as ExtractedRelation[]) : [],
    invalidations: Array.isArray(parsed.invalidations)
      ? (parsed.invalidations as ExtractionResult["invalidations"])
      : [],
  };
}
