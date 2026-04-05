/**
 * OpenClaw Memory Graph Plugin
 *
 * Knowledge graph memory backed by openclaw-memory engine.
 * Provides tools (search/store/detail/graph/invalidate),
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
  memoryDetail,
  memoryGraph,
  memoryInvalidate,
  buildL0Context,
  formatL0AsPromptSection,
  extractAndMerge,
  type LlmExtractFn,
} from "openclaw-memory";
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
    const { entityFtsAvailable } = ensureGraphSchema({ db });
    const engine = new MemoryGraphEngine(db);

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
          const result = memoryGraphSearch(db, engine, {
            query: input.query,
            types: input.types,
            maxResults: input.maxResults ?? cfg.searchMaxResults,
            includeRelations: input.includeRelations,
          });
          return {
            content: [{ type: "text", text: result.formatted || "No matching entities found." }],
            details: { count: result.results.length, results: result.results },
          };
        },
      }),
      { name: "memory_graph_search" },
    );

    // -- memory_store ---------------------------------------------------------
    api.registerTool(
      (_ctx: ToolContext) => ({
        name: "memory_store",
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
          };
        },
      }),
      { name: "memory_store" },
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
          };
        },
      }),
      { name: "memory_invalidate" },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // -- Auto-recall: inject L0 entity roster before agent starts -------------
    if (cfg.autoRecall) {
      api.on("before_agent_start", async () => {
        const l0 = buildL0Context(engine, {
          maxEntities: cfg.recallMaxEntities,
          maxTokens: cfg.recallMaxTokens,
        });

        if (l0.entries.length === 0) return;

        const section = formatL0AsPromptSection(l0);
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
        } catch (err) {
          api.logger.warn(`memory-graph: auto-extract failed: ${err instanceof Error ? err.message : String(err)}`);
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
