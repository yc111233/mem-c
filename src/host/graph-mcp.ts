/**
 * MCP (Model Context Protocol) server for mem-c.
 * Exposes memory graph tools as MCP tools for cross-agent access.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import { MemoryGraphEngine } from "./graph-engine.js";
import { ensureGraphSchema } from "./graph-schema.js";
import {
  memoryGraphSearch,
  memoryStore,
  memoryDetail,
  memoryGraph,
  memoryInvalidate,
  memoryConsolidate,
  memoryDetectCommunities,
  memoryFindPaths,
  memoryExportGraph,
  memoryEpisodes,
  memoryTextUnits,
  memoryProposals,
  memoryResolveProposal,
  memoryRebuildIndex,
  memoryStats,
} from "./graph-tools.js";

export type McpServerOpts = {
  dbPath?: string;
  namespace?: string;
  embedFn?: (text: string) => number[];
};

export function createMemoryMcpServer(opts?: McpServerOpts): {
  server: McpServer;
  engine: MemoryGraphEngine;
  db: DatabaseSync;
} {
  const dbPath = opts?.dbPath ?? ":memory:";
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  const engine = new MemoryGraphEngine(db, {
    embedFn: opts?.embedFn,
    namespace: opts?.namespace,
  });
  ensureGraphSchema({ db, engine });

  const server = new McpServer({
    name: "mem-c",
    version: "0.6.0",
  });

  // memory_search
  server.tool(
    "memory_search",
    "Search the knowledge graph for relevant entities and relationships",
    { query: z.string(), types: z.array(z.string()).optional(), maxResults: z.number().optional() },
    async (params) => {
      const result = await memoryGraphSearch(db, engine, params);
      return { content: [{ type: "text" as const, text: result.formatted }] };
    },
  );

  // memory_store
  server.tool(
    "memory_store",
    "Store a new entity and optional relationships in the knowledge graph",
    {
      name: z.string(),
      type: z.string(),
      summary: z.string().optional(),
      relations: z.array(z.object({
        targetName: z.string(),
        targetType: z.string(),
        relation: z.string(),
      })).optional(),
    },
    async (params) => {
      const result = memoryStore(engine, params);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  // memory_detail
  server.tool(
    "memory_detail",
    "Get detailed information about a specific entity",
    { entity: z.string(), type: z.string().optional() },
    async (params) => {
      const result = memoryDetail(engine, params);
      return { content: [{ type: "text" as const, text: result.formatted }] };
    },
  );

  // memory_graph
  server.tool(
    "memory_graph",
    "Visualize relationships around an entity",
    { entity: z.string(), depth: z.number().optional() },
    async (params) => {
      const result = memoryGraph(engine, params);
      return { content: [{ type: "text" as const, text: result.formatted }] };
    },
  );

  // memory_invalidate
  server.tool(
    "memory_invalidate",
    "Mark an entity as no longer valid",
    { entity: z.string(), type: z.string().optional(), reason: z.string().optional() },
    async (params) => {
      const result = memoryInvalidate(engine, params);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  // memory_consolidate
  server.tool(
    "memory_consolidate",
    "Run graph consolidation (merge duplicates, decay stale, prune orphans)",
    { dryRun: z.boolean().optional() },
    async (params) => {
      const result = memoryConsolidate(engine, params);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  // memory_detect_communities
  server.tool(
    "memory_detect_communities",
    "Detect entity clusters/communities in the knowledge graph",
    {},
    async () => {
      const result = memoryDetectCommunities(engine, {});
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  // memory_find_paths
  server.tool(
    "memory_find_paths",
    "Find paths between two entities in the knowledge graph",
    { from: z.string(), to: z.string(), maxDepth: z.number().optional() },
    async (params) => {
      const result = memoryFindPaths(engine, params);
      return { content: [{ type: "text" as const, text: result.formatted }] };
    },
  );

  // memory_export
  server.tool(
    "memory_export",
    "Export the knowledge graph in Mermaid, DOT, or JSON format",
    { format: z.enum(["mermaid", "dot", "json"]).optional(), centerEntity: z.string().optional() },
    async (params) => {
      const result = memoryExportGraph(engine, params);
      return { content: [{ type: "text" as const, text: result.content }] };
    },
  );

  // memory_episodes
  server.tool(
    "memory_episodes",
    "List recorded conversation episodes, optionally filtered by session",
    { sessionKey: z.string().optional(), limit: z.number().optional() },
    async (params) => {
      const result = memoryEpisodes(engine, params);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  // memory_text_units
  server.tool(
    "memory_text_units",
    "Get text units (conversation turns) for a specific episode",
    { episodeId: z.string() },
    async (params) => {
      const result = memoryTextUnits(engine, params);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  // memory_proposals
  server.tool(
    "memory_proposals",
    "List supersession proposals for entity updates",
    { status: z.enum(["pending", "approved", "rejected"]).optional(), limit: z.number().optional() },
    async (params) => {
      const result = memoryProposals(engine, params);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  // memory_resolve_proposal
  server.tool(
    "memory_resolve_proposal",
    "Approve or reject a supersession proposal",
    { proposalId: z.string(), decision: z.enum(["approved", "rejected"]), reason: z.string().optional() },
    async (params) => {
      const result = memoryResolveProposal(engine, params);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  // memory_rebuild_index
  server.tool(
    "memory_rebuild_index",
    "Rebuild FTS, vector, or community indexes",
    { target: z.enum(["fts", "vec", "community", "all"]) },
    async (params) => {
      const result = memoryRebuildIndex(engine, params);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  // memory_stats
  server.tool(
    "memory_stats",
    "Get knowledge graph statistics (entities, edges, episodes, communities, proposals, properties)",
    {},
    async () => {
      const result = memoryStats(engine);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  return { server, engine, db };
}

export async function startMcpServer(opts?: McpServerOpts): Promise<void> {
  const { server, db } = createMemoryMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.on("exit", () => db.close());
}
