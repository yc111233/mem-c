/**
 * Document import pipeline: parse → chunk → extract → merge.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryGraphEngine } from "./graph-engine.js";
import type { LlmExtractFn } from "./graph-extractor.js";
import { extractAndMerge } from "./graph-extractor.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DocumentChunk = {
  index: number;
  content: string;
  heading?: string;
  headingLevel?: number;
};

export type DocumentParser = (content: string) => DocumentChunk[] | Promise<DocumentChunk[]>;

export type ImportOpts = {
  content: string;
  parser: DocumentParser;
  llmExtract: LlmExtractFn;
  sessionKey?: string;
  /** Max tokens per chunk (approximate, 4 chars/token). Default 2000. */
  chunkSize?: number;
  /** Existing import session ID for resume tracking. Omit to create new. */
  importSessionId?: string;
  /** Source type label (e.g., "markdown", "pdf", "feishu"). */
  sourceType?: string;
  /** Source file path for tracking. */
  sourcePath?: string;
};

export type ImportResult = {
  sessionId: string;
  chunksProcessed: number;
  entitiesCreated: number;
  entitiesUpdated: number;
  edgesCreated: number;
  errors: string[];
};

// ---------------------------------------------------------------------------
// Import Session Tracking
// ---------------------------------------------------------------------------

export type ImportSession = {
  id: string;
  sourceType: string;
  sourcePath: string | null;
  status: "pending" | "in_progress" | "completed" | "failed";
  totalChunks: number;
  processedChunks: number;
  entitiesCreated: number;
  entitiesUpdated: number;
  edgesCreated: number;
  errorCount: number;
  lastChunkIndex: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

/**
 * Create a new import session for tracking progress.
 */
export function createImportSession(
  db: DatabaseSync,
  sourceType: string,
  sourcePath?: string,
): ImportSession {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO import_sessions (id, source_type, source_path, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)`,
  ).run(id, sourceType, sourcePath ?? null, now, now);
  return getImportSession(db, id)!;
}

/**
 * Update import session progress.
 */
export function updateImportSession(
  db: DatabaseSync,
  id: string,
  updates: Partial<Pick<ImportSession, "status" | "totalChunks" | "processedChunks" | "entitiesCreated" | "entitiesUpdated" | "edgesCreated" | "errorCount" | "lastChunkIndex">>,
): void {
  const sets: string[] = ["updated_at = ?"];
  const params: (string | number)[] = [Date.now()];

  for (const [key, value] of Object.entries(updates)) {
    const col = key.replace(/([A-Z])/g, "_$1").toLowerCase();
    sets.push(`${col} = ?`);
    params.push(value as number | string);
  }
  if (updates.status === "completed") {
    sets.push("completed_at = ?");
    params.push(Date.now());
  }

  params.push(id);
  db.prepare(`UPDATE import_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

/**
 * Get an import session by ID.
 */
export function getImportSession(db: DatabaseSync, id: string): ImportSession | null {
  const row = db.prepare(`SELECT * FROM import_sessions WHERE id = ?`).get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    sourceType: row.source_type,
    sourcePath: row.source_path,
    status: row.status,
    totalChunks: row.total_chunks,
    processedChunks: row.processed_chunks,
    entitiesCreated: row.entities_created,
    entitiesUpdated: row.entities_updated,
    edgesCreated: row.edges_created,
    errorCount: row.error_count,
    lastChunkIndex: row.last_chunk_index,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

/**
 * List all import sessions, newest first.
 */
export function listImportSessions(db: DatabaseSync): ImportSession[] {
  const rows = db.prepare(`SELECT * FROM import_sessions ORDER BY created_at DESC`).all() as Array<any>;
  return rows.map((row) => ({
    id: row.id,
    sourceType: row.source_type,
    sourcePath: row.source_path,
    status: row.status,
    totalChunks: row.total_chunks,
    processedChunks: row.processed_chunks,
    entitiesCreated: row.entities_created,
    entitiesUpdated: row.entities_updated,
    edgesCreated: row.edges_created,
    errorCount: row.error_count,
    lastChunkIndex: row.last_chunk_index,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }));
}

// ---------------------------------------------------------------------------
// Smart Chunker
// ---------------------------------------------------------------------------

/**
 * Split text into chunks respecting semantic boundaries.
 * Tries paragraph breaks first, then sentences, then hard cut.
 */
export function smartChunk(
  text: string,
  maxChunkChars: number = 8000,
): string[] {
  if (text.length <= maxChunkChars) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChunkChars) {
      chunks.push(remaining);
      break;
    }

    const window = remaining.slice(0, maxChunkChars);
    let splitIdx = -1;

    // Priority 1: double newline (paragraph break)
    const paraBreak = window.lastIndexOf("\n\n");
    if (paraBreak > maxChunkChars * 0.3) {
      splitIdx = paraBreak + 2;
    }

    // Priority 2: single newline
    if (splitIdx < 0) {
      const lineBreak = window.lastIndexOf("\n");
      if (lineBreak > maxChunkChars * 0.3) {
        splitIdx = lineBreak + 1;
      }
    }

    // Priority 3: sentence end
    if (splitIdx < 0) {
      const sentenceEnd = window.search(/[.!?]\s+(?=[A-Z一-鿿])/);
      if (sentenceEnd > 0 && sentenceEnd > maxChunkChars * 0.3) {
        splitIdx = sentenceEnd + 1;
      }
    }

    // Priority 4: hard cut
    if (splitIdx < 0) {
      splitIdx = maxChunkChars;
    }

    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks.filter((c) => c.length > 0);
}

// ---------------------------------------------------------------------------
// Import Document
// ---------------------------------------------------------------------------

/**
 * Import a document into the memory graph.
 * Pipeline: parse → chunk → extract (per chunk) → merge.
 */
export async function importDocument(
  engine: MemoryGraphEngine,
  opts: ImportOpts,
): Promise<ImportResult> {
  // Create or use existing import session
  const sessionId = opts.importSessionId ?? createImportSession(
    engine.getDb(),
    opts.sourceType ?? "document",
    opts.sourcePath,
  ).id;

  const result: ImportResult = {
    sessionId,
    chunksProcessed: 0,
    entitiesCreated: 0,
    entitiesUpdated: 0,
    edgesCreated: 0,
    errors: [],
  };

  const maxChunkChars = (opts.chunkSize ?? 2000) * 4;
  const sessionKey = opts.sessionKey ?? `import-${Date.now()}`;

  const parsedChunks = await opts.parser(opts.content);

  const allChunks: DocumentChunk[] = [];
  for (const chunk of parsedChunks) {
    const subChunks = smartChunk(chunk.content, maxChunkChars);
    for (let i = 0; i < subChunks.length; i++) {
      allChunks.push({
        index: allChunks.length,
        content: subChunks[i]!,
        heading: chunk.heading,
        headingLevel: chunk.headingLevel,
      });
    }
  }

  if (allChunks.length === 0) {
    updateImportSession(engine.getDb(), sessionId, { status: "completed" });
    return result;
  }

  updateImportSession(engine.getDb(), sessionId, {
    status: "in_progress",
    totalChunks: allChunks.length,
  });

  const existingNames = engine.getActiveEntities().map((e) => e.name);

  for (const chunk of allChunks) {
    try {
      const contextualContent = chunk.heading
        ? `[Section: ${chunk.heading}]\n${chunk.content}`
        : chunk.content;

      const extractResult = await extractAndMerge({
        engine,
        transcript: contextualContent,
        sessionKey,
        turnIndex: chunk.index,
        llmExtract: opts.llmExtract,
        existingEntityNames: existingNames,
      });

      result.chunksProcessed++;
      result.entitiesCreated += extractResult.entitiesCreated;
      result.entitiesUpdated += extractResult.entitiesUpdated;
      result.edgesCreated += extractResult.edgesCreated;

      for (const err of extractResult.errors) {
        result.errors.push(`chunk ${chunk.index}: ${err}`);
      }

      updateImportSession(engine.getDb(), sessionId, {
        processedChunks: result.chunksProcessed,
        entitiesCreated: result.entitiesCreated,
        entitiesUpdated: result.entitiesUpdated,
        edgesCreated: result.edgesCreated,
        errorCount: result.errors.length,
        lastChunkIndex: chunk.index,
      });
    } catch (err) {
      result.errors.push(
        `chunk ${chunk.index}: ${err instanceof Error ? err.message : String(err)}`,
      );
      updateImportSession(engine.getDb(), sessionId, {
        errorCount: result.errors.length,
      });
    }
  }

  updateImportSession(engine.getDb(), sessionId, { status: "completed" });
  return result;
}

// ---------------------------------------------------------------------------
// Batch Chat Import
// ---------------------------------------------------------------------------

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: number;
};

export type BatchImportOpts = {
  llmExtract: LlmExtractFn;
  sessionKeyPrefix?: string;
};

export type BatchImportResult = {
  sessionsProcessed: number;
  totalEntitiesCreated: number;
  totalEntitiesUpdated: number;
  totalEdgesCreated: number;
  errors: string[];
};

/**
 * Import multiple chat sessions into the graph.
 * Each session is an array of messages that gets formatted as a transcript.
 */
export async function batchChatImport(
  engine: MemoryGraphEngine,
  sessions: ChatMessage[][],
  opts: BatchImportOpts,
): Promise<BatchImportResult> {
  const result: BatchImportResult = {
    sessionsProcessed: 0,
    totalEntitiesCreated: 0,
    totalEntitiesUpdated: 0,
    totalEdgesCreated: 0,
    errors: [],
  };

  const prefix = opts.sessionKeyPrefix ?? "chat";

  for (let i = 0; i < sessions.length; i++) {
    const messages = sessions[i]!;
    const transcript = messages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");

    if (transcript.trim().length === 0) continue;

    try {
      const extractResult = await extractAndMerge({
        engine,
        transcript,
        sessionKey: `${prefix}-${i}`,
        llmExtract: opts.llmExtract,
      });

      result.sessionsProcessed++;
      result.totalEntitiesCreated += extractResult.entitiesCreated;
      result.totalEntitiesUpdated += extractResult.entitiesUpdated;
      result.totalEdgesCreated += extractResult.edgesCreated;
    } catch (err) {
      result.errors.push(
        `session ${i}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}
