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
  /** Contradictions detected between new info and existing entities. */
  contradictions: Array<{
    existingEntityName: string;
    existingEntityType: string;
    newInfo: string;
    reason: string;
  }>;
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

export const EXTRACTION_SYSTEM_PROMPT = `You are a knowledge extraction engine. Given a conversation transcript, extract CONCRETE, SPECIFIC facts — not abstract categories.

Return ONLY valid JSON matching this schema:
{
  "entities": [
    { "name": string, "type": string, "summary": string, "confidence": number }
  ],
  "relations": [
    { "fromName": string, "fromType": string, "toName": string, "toType": string, "relation": string }
  ],
  "contradictions": [
    { "existingEntityName": string, "existingEntityType": string, "newInfo": string, "reason": string }
  ]
}

## Entity Types & Definitions

- user: The human user interacting with the AI. Extract their name, role, company. Example: {"name": "叶琛", "type": "user", "summary": "小米MiPush团队PM"}
- person: Someone mentioned in conversation (not the user). Example: {"name": "张三", "type": "person", "summary": "叶琛的同事，负责后端"}
- project: A specific project, product, or initiative. Example: {"name": "MiPush", "type": "project", "summary": "小米推送服务"}
- concept: A specific technical concept, framework, or methodology. Example: {"name": "React", "type": "concept", "summary": "前端UI框架"}
- file: A specific file, document, or resource. Example: {"name": "ARCHITECTURE.md", "type": "file", "summary": "项目架构文档"}
- decision: A concrete decision made. Example: {"name": "迁移到GraphQL", "type": "decision", "summary": "2026年4月决定从REST迁移到GraphQL"}
- feedback: Specific feedback given or received. Example: {"name": "代码review反馈", "type": "feedback", "summary": "叶琛指出API设计需要更简洁"}
- tool: A specific tool, service, or platform. Example: {"name": "飞书多维表格", "type": "tool", "summary": "用于项目管理的数据表格"}
- preference: A specific like/dislike/preference. Example: {"name": "偏好Python", "type": "preference", "summary": "写脚本偏好用Python而非Shell"}
- event: A specific event that happened. Example: {"name": "4月团队技术分享", "type": "event", "summary": "2026年4月团队分享了AI Agent架构"}
- skill: A specific skill or capability. Example: {"name": "SQL查询", "type": "skill", "summary": "能写复杂SQL做数据分析"}
- location: A specific place. Example: {"name": "小米科技园", "type": "location", "summary": "叶琛工作地点"}
- habit: A recurring behavior pattern. Example: {"name": "凌晨工作", "type": "habit", "summary": "经常凌晨2-3点还在写代码"}

## Relation Types

works_on, decided, prefers, knows, uses, created, depends_on, relates_to, replaced_by, lives_in, learned, experienced, dislikes, habitually_do

## CRITICAL RULES

- Extract SPECIFIC names, not categories. "叶琛" ✅  "用户" ❌  "React" ✅  "前端框架" ❌
- Extract SPECIFIC preferences and habits. "喜欢用Python写脚本" ✅  "会编程" ❌
- Extract SPECIFIC events and decisions. "在4月讨论了从REST迁移到GraphQL" ✅  "讨论了技术选型" ❌
- Extract SPECIFIC tools and skills. "会用飞书多维表格" ✅  "会用办公软件" ❌
- summary field must be a concrete 1-sentence description, not a category name.
- Set confidence between 0.5 (inferred) to 1.0 (explicitly stated).
- If a new fact contradicts a previous fact, add a contradiction entry with the new info and reason.
- Keep entity names concise (1-4 words). Use proper nouns when available.
- Do NOT extract greetings, filler, or generic statements like "会写代码" or "懂技术".
- Do NOT output abstract categories as entities. Every entity must be a CONCRETE thing.
- Prefer extracting 5-10 specific facts over 20 vague ones.
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
  supersessionProposals: number;
  assertionsRecorded: number;
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
    supersessionProposals: 0,
    assertionsRecorded: 0,
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

  // Wrap all database mutations in a single transaction
  params.engine.runInTransaction(() => {
    // Upsert entities first (so we have IDs for assertions)
    const nameToId = new Map<string, string>();
    for (const extracted of extraction.entities) {
      try {
        const entity = params.engine.upsertEntity({
          name: extracted.name,
          type: extracted.type,
          summary: extracted.summary,
          confidence: extracted.confidence,
          source: "auto",
        });

        nameToId.set(`${extracted.name}:${extracted.type}`, entity.id);

        if (entity.isNew) {
          result.entitiesCreated++;
        } else {
          result.entitiesUpdated++;
        }

        // Record each extracted entity summary as a fact assertion
        if (extracted.summary) {
          try {
            params.engine.recordAssertion({
              entityId: entity.id,
              assertionText: extracted.summary,
              confidence: extracted.confidence ?? 1.0,
            });
            result.assertionsRecorded++;
          } catch (err) {
            result.errors.push(`Assertion recording failed for "${extracted.name}": ${err instanceof Error ? err.message : String(err)}`);
          }
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

    // Process contradictions as supersession proposals (NOT direct invalidations)
    for (const contradiction of extraction.contradictions) {
      try {
        const matches = params.engine.findEntities({
          name: contradiction.existingEntityName,
          type: contradiction.existingEntityType,
          activeOnly: true,
          limit: 1,
        });
        if (matches.length > 0) {
          params.engine.createSupersessionProposal({
            targetEntityId: matches[0]!.id,
            newAssertionText: contradiction.newInfo,
            reason: contradiction.reason,
          });
          result.supersessionProposals++;
        }
      } catch (err) {
        result.errors.push(`Supersession proposal failed for "${contradiction.existingEntityName}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Record episode
    try {
      const entityIds = Array.from(nameToId.values());
      const episode = params.engine.recordEpisode({
        sessionKey: params.sessionKey,
        turnIndex: params.turnIndex,
        content: params.transcript.length > 2000
          ? params.transcript.slice(0, 2000) + "..."
          : params.transcript,
        extractedEntityIds: entityIds,
      });

      // Record text unit for provenance tracking
      try {
        params.engine.recordTextUnit({
          episodeId: episode.id,
          content: params.transcript.length > 4000
            ? params.transcript.slice(0, 4000) + "..."
            : params.transcript,
          turnIndex: params.turnIndex,
        });
      } catch {
        // Non-fatal: text unit is supplementary
      }

      result.episodeRecorded = true;
    } catch (err) {
      result.errors.push(`Episode recording failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

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
    contradictions: Array.isArray(parsed.contradictions)
      ? (parsed.contradictions as ExtractionResult["contradictions"])
      : [],
  };
}
