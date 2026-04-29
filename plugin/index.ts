/**
 * MEM-C Memory Graph Plugin
 *
 * Knowledge graph memory backed by mem-c engine.
 * Provides tools (search/store/batch/detail/graph/invalidate/consolidate/community/path/export),
 * lifecycle hooks (auto-recall/auto-extract), and CLI commands.
 *
 * Designed to run alongside memory-viking — complementary, not competing:
 * - OpenViking: raw conversation storage + semantic vector search
 * - This plugin: structured knowledge graph + temporal versioning + graph traversal
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ensureGraphSchema,
  MemoryGraphEngine,
  memoryGraphSearch,
  memoryStore,
  memoryBatchStore,
  memoryDetail,
  memoryGraph,
  memoryInvalidate,
  memoryConsolidate,
  memoryDetectCommunities,
  memoryFindPaths,
  memoryExportGraph,
  consolidateGraph,
  buildL0Context,
  buildQueryAwareL0Context,
  formatL0AsPromptSection,
  suggestBudgets,
  extractAndMerge,
  type LlmExtractFn,
  type EmbedFn,
} from "mem-c";
import { memoryGraphConfigSchema } from "./config.js";

// ---------------------------------------------------------------------------
// Types (matching OpenClaw plugin SDK patterns)
// ---------------------------------------------------------------------------

type ToolContext = {
  sessionKey?: string;
  sessionId?: string;
};

/** Minimal OpenClaw plugin API surface (mirrors memory-viking's api.ts) */
type OpenClawPluginApi = {
  pluginConfig: unknown;
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
  registerTool: (
    factory: (ctx: ToolContext) => {
      name: string;
      label: string;
      description: string;
      parameters: unknown;
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
    },
    opts: { name: string },
  ) => void;
  registerCli: (
    factory: (opts: { program: unknown }) => void,
    opts: { commands: string[] },
  ) => void;
  registerService: (service: { id: string; start: () => Promise<void>; stop: () => void }) => void;
  on: (event: string, handler: (event?: unknown) => Promise<unknown>) => void;
  /** Optional: host-provided embedding function for auto-generating embeddings. */
  getEmbedFn?: () => EmbedFn | undefined;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractAllUserText(messages?: unknown[]): string {
  if (!messages || !Array.isArray(messages)) return "";
  const texts: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const msgObj = msg as Record<string, unknown>;
    if (msgObj.role !== "user") continue;
    if (typeof msgObj.content === "string") {
      texts.push(msgObj.content);
    } else if (Array.isArray(msgObj.content)) {
      for (const block of msgObj.content) {
        if (
          block &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          texts.push((block as Record<string, unknown>).text as string);
        }
      }
    }
  }
  return texts.join("\n\n");
}

/** Extract the latest user message text (for query-aware L0 injection). */
function extractLatestUserText(messages?: unknown[]): string {
  if (!messages || !Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const msgObj = msg as Record<string, unknown>;
    if (msgObj.role !== "user") continue;
    if (typeof msgObj.content === "string") return msgObj.content;
    if (Array.isArray(msgObj.content)) {
      for (const block of msgObj.content) {
        if (
          block &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          return (block as Record<string, unknown>).text as string;
        }
      }
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Plugin Definition
// ---------------------------------------------------------------------------

export default {
  id: "memory-graph",
  name: "Memory (Knowledge Graph)",
  description: "Temporal knowledge graph memory with hybrid retrieval",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    const cfg = memoryGraphConfigSchema.parse(api.pluginConfig);

    // Initialize database
    mkdirSync(dirname(cfg.dbPath), { recursive: true });
    const db = new DatabaseSync(cfg.dbPath);

    // Lazy embedFn: delegates to host on each call so late registration works
    const lazyEmbedFn: EmbedFn | undefined = api.getEmbedFn
      ? (text: string) => {
          const fn = api.getEmbedFn!();
          if (!fn) throw new Error("embedFn not available from host");
          return fn(text);
        }
      : undefined;
    const engine = new MemoryGraphEngine(db, lazyEmbedFn ? { embedFn: lazyEmbedFn } : undefined);
    const { entityFtsAvailable } = ensureGraphSchema({ db, engine });

    if (!entityFtsAvailable) {
      api.logger.warn("memory-graph: FTS5 unavailable, falling back to LIKE search");
    }

    // ========================================================================
    // Tools
    // ========================================================================

    // -- memory_graph_search --------------------------------------------------
    api.registerTool(
      (_ctx: ToolContext) => ({
        name: "memory_graph_search",
        label: "Memory Graph Search",
        description:
          "Search the knowledge graph for entities matching a query. " +
          "Uses hybrid retrieval: FTS + graph connectivity + time decay.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            types: {
              type: "array",
              items: { type: "string" },
              description: "Filter by entity types (user, project, concept, etc.)",
            },
            maxResults: { type: "number", description: `Max results (default: ${cfg.searchMaxResults})` },
            includeRelations: { type: "boolean", description: "Include relations (default: true)" },
          },
          required: ["query"],
        },
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const input = params as { query: string; types?: string[]; maxResults?: number; includeRelations?: boolean };
          const result = await memoryGraphSearch(db, engine, {
            query: input.query,
            types: input.types,
            maxResults: input.maxResults ?? cfg.searchMaxResults,
            includeRelations: input.includeRelations,
          });
          return {
            content: [{ type: "text", text: result.formatted || "No matching entities found." }],
            details: { count: result.results.length, results: result.results },
            clearable: true,
          };
        },
      }),
      { name: "memory_graph_search" },
    );

    // -- memory_graph_store ----------------------------------------------------
    api.registerTool(
      (_ctx: ToolContext) => ({
        name: "memory_graph_store",
        label: "Memory Store (Graph)",
        description:
          "Store an entity in the knowledge graph. Supports upsert semantics " +
          "and optional relationship creation.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Entity name" },
            type: { type: "string", description: "Entity type (user, project, concept, file, decision, feedback, tool, preference)" },
            summary: { type: "string", description: "Entity summary" },
            confidence: { type: "number", description: "Confidence 0-1 (default: 1.0)" },
            relations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  targetName: { type: "string" },
                  targetType: { type: "string" },
                  relation: { type: "string" },
                },
                required: ["targetName", "targetType", "relation"],
              },
              description: "Relations to create",
            },
          },
          required: ["name", "type"],
        },
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const result = memoryStore(engine, params as Parameters<typeof memoryStore>[1]);
          const action = result.isNew ? "Created" : "Updated";
          return {
            content: [{
              type: "text",
              text: `${action} entity "${result.name}" (${result.edgesCreated} relations created).`,
            }],
            details: result,
            clearable: true,
          };
        },
      }),
      { name: "memory_graph_store" },
    );

    // -- memory_batch_store ---------------------------------------------------
    api.registerTool(
      (_ctx: ToolContext) => ({
        name: "memory_batch_store",
        label: "Memory Batch Store (Graph)",
        description:
          "Store multiple entities and their relations in one batch transaction.",
        parameters: {
          type: "object",
          properties: {
            entities: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  type: { type: "string" },
                  summary: { type: "string" },
                  confidence: { type: "number" },
                  relations: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        targetName: { type: "string" },
                        targetType: { type: "string" },
                        relation: { type: "string" },
                      },
                      required: ["targetName", "targetType", "relation"],
                    },
                  },
                },
                required: ["name", "type"],
              },
              description: "Entities to upsert in a single transaction",
            },
          },
          required: ["entities"],
        },
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const result = await memoryBatchStore(engine, params as Parameters<typeof memoryBatchStore>[1]);
          return {
            content: [{
              type: "text",
              text:
                `Stored ${result.totalEntities} entities in batch ` +
                `(${result.totalEdges} relations created).`,
            }],
            details: result,
            clearable: true,
          };
        },
      }),
      { name: "memory_batch_store" },
    );

    // -- memory_detail --------------------------------------------------------
    api.registerTool(
      (_ctx: ToolContext) => ({
        name: "memory_detail",
        label: "Memory Detail (Graph)",
        description:
          "Get full details for an entity: summary, all relationships, " +
          "version history, and related conversation episodes.",
        parameters: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Entity name or ID" },
            type: { type: "string", description: "Entity type (helps disambiguate)" },
          },
          required: ["entity"],
        },
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const result = memoryDetail(engine, params as Parameters<typeof memoryDetail>[1]);
          return {
            content: [{ type: "text", text: result.formatted }],
            details: { found: result.found, entityId: result.entityId },
            clearable: true,
          };
        },
      }),
      { name: "memory_detail" },
    );

    // -- memory_graph ---------------------------------------------------------
    api.registerTool(
      (_ctx: ToolContext) => ({
        name: "memory_graph",
        label: "Memory Graph Visualize",
        description: "Visualize relationships around an entity in the knowledge graph.",
        parameters: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Center entity name or ID" },
            depth: { type: "number", description: "BFS depth (default: 1)" },
          },
          required: ["entity"],
        },
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const result = memoryGraph(engine, params as Parameters<typeof memoryGraph>[1]);
          return {
            content: [{ type: "text", text: result.formatted }],
            details: { found: result.found, entities: result.entities.length, edges: result.edges.length },
            clearable: true,
          };
        },
      }),
      { name: "memory_graph" },
    );

    // -- memory_invalidate ----------------------------------------------------
    api.registerTool(
      (_ctx: ToolContext) => ({
        name: "memory_invalidate",
        label: "Memory Invalidate (Graph)",
        description: "Mark an entity as outdated (soft delete with temporal tracking).",
        parameters: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Entity name or ID" },
            type: { type: "string", description: "Entity type" },
            reason: { type: "string", description: "Reason for invalidation" },
          },
          required: ["entity"],
        },
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const result = memoryInvalidate(engine, params as Parameters<typeof memoryInvalidate>[1]);
          const text = result.invalidated
            ? `Invalidated entity (${result.reason}).`
            : result.reason ?? "Entity not found.";
          return {
            content: [{ type: "text", text }],
            details: result,
            clearable: true,
          };
        },
      }),
      { name: "memory_invalidate" },
    );

    // -- memory_consolidate ---------------------------------------------------
    api.registerTool(
      (_ctx: ToolContext) => ({
        name: "memory_consolidate",
        label: "Memory Consolidate (Graph)",
        description:
          "Consolidate the knowledge graph: merge duplicate entities, " +
          "decay stale ones, and prune low-confidence orphans.",
        parameters: {
          type: "object",
          properties: {
            dryRun: { type: "boolean", description: "Preview changes without applying (default: false)" },
          },
        },
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const result = memoryConsolidate(engine, params as { dryRun?: boolean });
          const parts = [
            result.merged > 0 ? `${result.merged} merged` : null,
            result.decayed > 0 ? `${result.decayed} decayed` : null,
            result.pruned > 0 ? `${result.pruned} pruned` : null,
          ].filter(Boolean);
          const summary = parts.length > 0 ? parts.join(", ") : "no changes needed";
          const prefix = (params as { dryRun?: boolean }).dryRun ? "[dry run] " : "";
          return {
            content: [{ type: "text", text: `${prefix}Consolidation: ${summary}.` }],
            details: result,
            clearable: true,
          };
        },
      }),
      { name: "memory_consolidate" },
    );

    // -- memory_detect_communities -------------------------------------------
    api.registerTool(
      (_ctx: ToolContext) => ({
        name: "memory_detect_communities",
        label: "Memory Detect Communities",
        description: "Detect connected communities in the knowledge graph.",
        parameters: {
          type: "object",
          properties: {
            activeOnly: {
              type: "boolean",
              description: "Only consider active entities and edges (default: true)",
            },
          },
        },
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const result = memoryDetectCommunities(
            engine,
            params as Parameters<typeof memoryDetectCommunities>[1],
          );
          return {
            content: [{
              type: "text",
              text:
                `Detected ${result.communityCount} communities ` +
                `covering ${result.totalEntities} entities.`,
            }],
            details: result,
            clearable: true,
          };
        },
      }),
      { name: "memory_detect_communities" },
    );

    // -- memory_find_paths ----------------------------------------------------
    api.registerTool(
      (_ctx: ToolContext) => ({
        name: "memory_find_paths",
        label: "Memory Find Paths",
        description: "Find multi-hop paths between two entities in the knowledge graph.",
        parameters: {
          type: "object",
          properties: {
            from: { type: "string", description: "Source entity name or ID" },
            to: { type: "string", description: "Target entity name or ID" },
            maxDepth: { type: "number", description: "Maximum hop count (default: 3)" },
            maxPaths: { type: "number", description: "Maximum paths to return (default: 5)" },
          },
          required: ["from", "to"],
        },
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const result = memoryFindPaths(engine, params as Parameters<typeof memoryFindPaths>[1]);
          return {
            content: [{ type: "text", text: result.formatted }],
            details: result,
            clearable: true,
          };
        },
      }),
      { name: "memory_find_paths" },
    );

    // -- memory_export_graph --------------------------------------------------
    api.registerTool(
      (_ctx: ToolContext) => ({
        name: "memory_export_graph",
        label: "Memory Export Graph",
        description: "Export the graph as Mermaid, DOT, or JSON.",
        parameters: {
          type: "object",
          properties: {
            format: {
              type: "string",
              enum: ["mermaid", "dot", "json"],
              description: "Export format (default: mermaid)",
            },
            centerEntity: { type: "string", description: "Optional center entity name or ID" },
            depth: { type: "number", description: "Optional export depth around center entity" },
          },
        },
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const result = memoryExportGraph(engine, params as Parameters<typeof memoryExportGraph>[1]);
          return {
            content: [{ type: "text", text: result.content }],
            details: result,
            clearable: true,
          };
        },
      }),
      { name: "memory_export_graph" },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // Track message count for compaction detection (C3)
    let lastMessageCount = 0;

    // -- Auto-recall: inject L0 entity roster before agent starts -------------
    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event) => {
        const eventObj = (event ?? {}) as {
          messages?: unknown[];
          prompt?: string;
        };

        // C3: detect compaction (message count dropped by >50%)
        const currentMessageCount = Array.isArray(eventObj.messages) ? eventObj.messages.length : 0;
        const compactionDetected = lastMessageCount > 0 && currentMessageCount < lastMessageCount * 0.5;
        lastMessageCount = currentMessageCount;

        // Derive token budget: explicit config > default heuristic
        const budget = suggestBudgets(
          cfg.recallAvailableBudget > 0
            ? cfg.recallAvailableBudget
            : cfg.recallMaxTokens * 5,
        );

        // C3: boost L0 budget after compaction to compensate for lost context
        const effectiveL0Budget = compactionDetected
          ? Math.floor(budget.l0 * 1.5)
          : budget.l0;

        if (compactionDetected) {
          api.logger.info("memory-graph: compaction detected, boosting L0 context");
        }

        // Extract latest user query for query-aware injection
        const queryText =
          extractLatestUserText(eventObj.messages) ||
          (typeof eventObj.prompt === "string" ? eventObj.prompt.trim() : "");

        const l0 =
          queryText.length >= 5
            ? buildQueryAwareL0Context(db, engine, queryText, {
                maxEntities: cfg.recallMaxEntities,
                maxTokens: effectiveL0Budget,
                useImportance: true,
              })
            : buildL0Context(engine, {
                maxEntities: cfg.recallMaxEntities,
                maxTokens: effectiveL0Budget,
                useImportance: true,
              });

        if (l0.entries.length === 0) return;

        let section = formatL0AsPromptSection(l0);

        // Enrich with top relations for each entity
        const relLines: string[] = [];
        const entityNames = l0.entries.map((e) => e.match(/^- (.+?) \(/)?.[1]).filter(Boolean);
        for (const name of entityNames.slice(0, 15)) {
          const matches = engine.findEntities({ name, activeOnly: true, limit: 1 });
          const entity = matches[0];
          if (!entity) continue;
          const edges = engine.findEdges({ entityId: entity.id, activeOnly: true, limit: 5 });
          for (const edge of edges.slice(0, 3)) {
            const isOutgoing = edge.from_id === entity.id;
            const targetId = isOutgoing ? edge.to_id : edge.from_id;
            const target = engine.getEntity(targetId);
            if (!target) continue;
            const arrow = isOutgoing ? "->" : "<-";
            relLines.push(`${name} ${arrow}[${edge.relation}] ${target.name}`);
          }
        }
        if (relLines.length > 0) {
          section += "\n\n## Key Relationships\n" + relLines.join("\n");
        }
        return {
          prependContext:
            "<knowledge-graph-context>\n" +
            section +
            "\n</knowledge-graph-context>",
        };
      });
    }

    // -- Auto-extract: extract entities from conversation after agent ends -----
    if (cfg.autoExtract) {
      api.on("agent_end", async (event) => {
        const eventObj = (event ?? {}) as {
          success?: boolean;
          messages?: unknown[];
          sessionId?: string;
          sessionKey?: string;
          llmExtract?: LlmExtractFn;
        };

        if (!eventObj.success) return;

        const transcript = extractAllUserText(eventObj.messages);
        if (transcript.length < 50) return;

        // llmExtract must be provided by the host runtime
        const llmExtract = eventObj.llmExtract;
        if (!llmExtract) {
          api.logger.warn("memory-graph: auto-extract skipped — no llmExtract function provided");
          return;
        }

        try {
          const existingNames = engine
            .getActiveEntities()
            .map((e) => e.name);

          const result = await extractAndMerge({
            engine,
            transcript,
            sessionKey: eventObj.sessionKey ?? eventObj.sessionId ?? "unknown",
            llmExtract,
            existingEntityNames: existingNames,
          });

          api.logger.info(
            `memory-graph: extracted ${result.entitiesCreated} new + ${result.entitiesUpdated} updated entities, ` +
              `${result.edgesCreated} edges, ${result.invalidated} invalidations` +
              (result.errors.length > 0 ? ` (${result.errors.length} errors)` : ""),
          );

          // Auto-consolidation: run at most once per 24 hours
          try {
            const lastRow = db.prepare(`SELECT value FROM meta WHERE key = 'last_consolidate_at'`).get() as
              | { value: string }
              | undefined;
            const lastConsolidateAt = lastRow ? Number(lastRow.value) : 0;
            const hoursSince = (Date.now() - lastConsolidateAt) / 3_600_000;
            if (hoursSince >= 24) {
              const cr = consolidateGraph(engine);
              db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('last_consolidate_at', ?)`)
                .run(String(Date.now()));
              if (cr.merged + cr.decayed + cr.pruned > 0) {
                api.logger.info(
                  `memory-graph: auto-consolidation — ${cr.merged} merged, ${cr.decayed} decayed, ${cr.pruned} pruned`,
                );
              }
            }
          } catch (err) {
            api.logger.warn(`memory-graph: auto-consolidation failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        } catch (err) {
          api.logger.warn(`memory-graph: auto-extract failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }

    // -- C2: Pre-compaction hook — extract entities before context is compressed --
    if (cfg.autoExtract) {
      api.on("before_compaction", async (event) => {
        const eventObj = (event ?? {}) as {
          messages?: unknown[];
          sessionId?: string;
          sessionKey?: string;
          llmExtract?: LlmExtractFn;
        };

        const transcript = extractAllUserText(eventObj.messages);
        if (transcript.length < 50) return;

        const llmExtract = eventObj.llmExtract;
        if (!llmExtract) return;

        try {
          const existingNames = engine.getActiveEntities().map((e) => e.name);
          await extractAndMerge({
            engine,
            transcript,
            sessionKey: eventObj.sessionKey ?? eventObj.sessionId ?? "unknown",
            llmExtract,
            existingEntityNames: existingNames,
          });
          api.logger.info("memory-graph: pre-compaction extraction complete");
        } catch (err) {
          api.logger.warn(
            `memory-graph: pre-compaction extraction failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "memory-graph",
      start: async () => {
        const stats = engine.stats();
        api.logger.info(
          `memory-graph: initialized (${stats.activeEntities} active entities, ` +
            `${stats.edges} edges, FTS: ${entityFtsAvailable ? "yes" : "no"})`,
        );
      },
      stop: () => {
        db.close();
        api.logger.info("memory-graph: database closed");
      },
    });
  },
};
