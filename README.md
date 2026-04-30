# MEM-C

Temporal knowledge graph memory for AI agents — SQLite-based, zero-infrastructure, with hybrid retrieval (vector + FTS + graph traversal), MCP Server, document import, backup/restore.

**v1.1.0** | [API Reference](./docs/api-reference.md) | [Getting Started](./docs/getting-started.md) | [中文文档](./README.zh-CN.md)

## Features

**Core**
- **Temporal versioning** — `valid_from` / `valid_until` on entities and edges; track when facts change
- **Hybrid search** — vector similarity + FTS5 full-text + graph connectivity + time decay scoring
- **Tiered context loading** — L0 (entity roster, ~200 tokens) / L1 (search results, ~800 tokens) / L2 (full detail, ~2000 tokens)
- **Entity importance scoring** — composite metric (recency + degree centrality + access frequency + confidence)
- **Graph consolidation** — automatic merge of duplicates, decay of stale entities, pruning of low-confidence orphans
- **LLM extraction** — automatic entity/relation extraction from conversation transcripts
- **Zero infrastructure** — pure `node:sqlite` (Node 22+), no external databases

**Performance (v0.4+)**
- **sqlite-vec ANN index** — optional approximate nearest neighbor search, graceful fallback to full scan
- **Incremental embeddings** — `embedFn` only called when content changes (tracked via `content_hash`)
- **Batch operations** — `upsertEntities()` / `addEdges()` for multi-item transactions
- **FTS score normalization** — meaningful scores even with small document sets
- **Search result cache** — LRU cache (128 entries, 30s TTL), auto-invalidation on writes

**Graph Intelligence (v0.5+)**
- **Community detection** — BFS connected components, stored in `communities`/`community_members` tables
- **Multi-hop path finding** — BFS with cycle discovery between any two entities
- **Graph visualization export** — Mermaid, DOT, JSON formats
- **Community summaries** — LLM-generated labels for each community cluster
- **Relation type inference** — LLM suggests richer relation types for generic edges

**Ecosystem (v0.6+)**
- **MCP Server** — Model Context Protocol for cross-agent memory sharing (9 tools)
- **Multi-user isolation** — namespace-based scoping for entities, edges, and episodes
- **Event-driven API** — typed `GraphEventEmitter` with 7 lifecycle events
- **REST API** — HTTP endpoints for non-Node.js consumers (8 routes, zero deps)

**Model Integration (v1.1+)**
- **Built-in model config** — `mem-c.config.json` configures chat/embedding/rerank providers; plugin auto-uses built-in LLM without host callbacks
- **Rerank pipeline** — OpenAI-compatible rerank API for improved search relevance
- **DashScope native embedding** — DashScope multimodal embedding alongside OpenAI-compatible endpoints

**Document Import (v1.0+)**
- **Unified import API** — `importDocument()` for markdown, PDF, Feishu, and chat history
- **Smart chunking** — semantic boundary-aware text splitting (paragraph > sentence > hard cut)
- **Import progress tracking** — `import_sessions` table with resume support
- **Backup & restore** — incremental backup, point-in-time recovery

**Safety**
- **Edge deduplication** — automatic merge of duplicate edges with weight updates
- **Binary embedding storage** — BLOB storage for 60% space reduction vs JSON
- **FTS query safety** — sanitized queries prevent crashes on special characters
- **Multi-process safe** — WAL journal mode + busy_timeout for concurrent access

## Install

```bash
npm install mem-c
```

## Architecture

```
src/host/
├── graph-schema.ts         # SQLite DDL + FTS5 virtual table + vec0 ANN index
├── graph-engine.ts         # CRUD + graph traversal + temporal versioning + namespace isolation
├── graph-search.ts         # Hybrid retrieval (vector + FTS + graph + time decay + cache)
├── graph-context-loader.ts # L0/L1/L2 tiered context loading
├── graph-consolidator.ts   # Graph hygiene: merge duplicates, decay stale, prune orphans
├── graph-extractor.ts      # LLM entity/relation extraction
├── graph-import.ts         # Document import pipeline (markdown, PDF, Feishu, chat)
├── graph-backup.ts         # Backup & restore (incremental, point-in-time)
├── graph-llm-client.ts     # Built-in LLM client (chat/embedding/rerank)
├── graph-model-config.ts   # Model provider configuration
├── graph-model-adapters.ts # Provider adapters (OpenAI-compatible, DashScope)
├── graph-migrate.ts        # Markdown memory → graph migration
├── graph-tools.ts          # Agent tool interfaces
├── graph-vec.ts            # sqlite-vec ANN adapter
├── graph-community.ts      # Community detection + LLM summaries
├── graph-inference.ts      # Relation type inference
├── graph-export.ts         # Mermaid/DOT/JSON visualization export
├── graph-events.ts         # Typed EventEmitter for lifecycle events
├── graph-mcp.ts            # MCP server for cross-agent sharing
└── graph-rest.ts           # REST API (HTTP)
```

## Quick Start

```typescript
import { DatabaseSync } from "node:sqlite";
import { ensureGraphSchema, MemoryGraphEngine, searchGraph } from "mem-c";

// Initialize
const db = new DatabaseSync("memory.db");
const engine = new MemoryGraphEngine(db);
const { entityFtsAvailable } = ensureGraphSchema({ db, engine });

// Store entities
const user = engine.upsertEntity({ name: "Alice", type: "user", summary: "Lead engineer" });
const project = engine.upsertEntity({ name: "GraphDB", type: "project", summary: "Graph database project" });

// Create relationships (auto-deduplicates)
engine.addEdge({ fromId: user.id, toId: project.id, relation: "works_on" });

// Search
const results = searchGraph(db, engine, "Alice project");
console.log(results[0]?.entity.name, results[0]?.score);

// Temporal: invalidate outdated facts
engine.invalidateEntity(project.id, "project completed");
const history = engine.getEntityHistory("GraphDB"); // see all versions
```

### With Embedding Hook (v0.3+)

```typescript
import { MemoryGraphEngine } from "mem-c";

// Provide embedding function
const engine = new MemoryGraphEngine(db, {
  embedFn: (text: string) => {
    // Your embedding model here (e.g., OpenAI, local model)
    return generateEmbedding(text);
  }
});

// Embeddings auto-generated on upsert
engine.upsertEntity({ name: "React", type: "concept", summary: "UI library" });
// Embedding automatically created from "React UI library"

// Query embeddings auto-generated in search
const results = searchGraph(db, engine, "JavaScript frameworks");
// Query embedding automatically generated, no need to pass queryEmbedding
```

### Entity Aliases (v0.3+)

```typescript
// Case-insensitive matching
engine.upsertEntity({ name: "React", type: "concept" });
engine.upsertEntity({ name: "react", type: "concept" }); // Merges into same entity

// Custom aliases
const entity = engine.upsertEntity({ name: "React", type: "concept" });
engine.addAlias(entity.id, "ReactJS");
engine.addAlias(entity.id, "React.js");

// Find by any alias
const results = engine.findEntities({ name: "reactjs", type: "concept" });
// Returns the "React" entity
```

## Context Tiers

| Tier | Purpose | Token Budget | When Used |
|------|---------|-------------|-----------|
| **L0** | Entity roster for system prompt | ~200 | Every request |
| **L1** | Search-triggered summaries + relations | ~800 | On memory search |
| **L2** | Full entity detail + history + episodes | ~2000 | On-demand drill-down |

```typescript
import { buildL0Context, buildL1Context, buildL2Context, formatL0AsPromptSection } from "mem-c";

const l0 = buildL0Context(engine, { maxTokens: 200 });
const systemPromptSection = formatL0AsPromptSection(l0);

const l1 = buildL1Context(db, engine, "user query here");
const l2 = buildL2Context(engine, entityId);
```

## LLM Extraction

MEM-C supports two modes for LLM-powered extraction:

**Built-in model (v1.1+):** Configure `mem-c.config.json` with a chat provider — the plugin auto-uses it for extraction, no host callback needed.

**Callback injection:** The host runtime provides an `llmExtract` function. This is the fallback when no built-in model is configured.

```typescript
import { extractAndMerge } from "mem-c";

// Callback mode — host provides the LLM call
const result = await extractAndMerge({
  engine,
  transcript: "User discussed switching from REST to GraphQL...",
  sessionKey: "session-123",
  llmExtract: async ({ systemPrompt, userPrompt }) => {
    return await callLLM(systemPrompt, userPrompt);
  },
});
// result: { entitiesCreated: 2, edgesCreated: 1, ... }
```

## Agent Tools

The library exports 12 pre-built tool helpers.

| Tool | Function | Purpose |
|------|----------|---------|
| `memoryGraphSearch` | Hybrid search | Find relevant entities |
| `memoryStore` | Create/update entity | Store facts with relations |
| `memoryBatchStore` | Batch upsert | Store multiple entities in one transaction |
| `memoryDetail` | L2 context | Get full entity detail |
| `memoryGraph` | Graph visualization | Show entity relationships |
| `memoryInvalidate` | Soft delete | Mark facts as outdated |
| `memoryConsolidate` | Graph hygiene | Merge duplicates, decay stale, prune orphans |
| `memoryDetectCommunities` | Community detection | Find connected clusters |
| `memoryFindPaths` | Multi-hop traversal | Discover paths between entities |
| `memoryExportGraph` | Graph export | Export Mermaid / DOT / JSON |
| `memorySummarizeCommunities` | Callback-driven summary | Summarize communities with host LLM |
| `memoryInferRelations` | Callback-driven inference | Suggest richer relation types with host LLM |

The OpenClaw plugin registers the 10 JSON-native tools above up through `memoryExportGraph`.
The two callback-driven helpers (`memorySummarizeCommunities`, `memoryInferRelations`) are
available as library APIs. When `mem-c.config.json` is configured with a `chat` provider,
the plugin automatically uses the built-in LLM client for extraction.

## Importance Scoring

Entities are ranked by a composite importance score for smarter L0 context injection:

```typescript
// Importance = 0.3 × recency + 0.3 × degree + 0.25 × accessScore + 0.15 × confidence
const l0 = buildL0Context(engine, { maxTokens: 200, useImportance: true });
```

Access tracking is automatic — search hits and detail views call `touchEntity()` under the hood.

## Graph Consolidation

Periodic cleanup to maintain graph hygiene:

```typescript
import { consolidateGraph } from "mem-c";

// Dry run first
const preview = consolidateGraph(engine, { dryRun: true });
console.log(preview); // { merged: 2, decayed: 5, pruned: 3, errors: [] }

// Execute
const result = consolidateGraph(engine);
```

Four phases run in a single transaction:
1. **Merge** — same-name entities with different types → keep highest confidence
2. **Decay** — reduce confidence of entities not accessed for 30+ days
3. **Prune** — invalidate low-confidence orphans (no edges, confidence < 0.3)

## Document Import (v1.0+)

```typescript
import { importDocument } from "mem-c";

// Import a markdown file
const result = await importDocument({
  engine,
  source: "/path/to/notes.md",
  parser: markdownParser(),
});
// result: { sessionId, entitiesCreated, edgesCreated, chunksProcessed }
```

Supports markdown, PDF, Feishu documents, and chat history. Progress tracked via `import_sessions` table.

## MCP Server (v0.6+)

Expose memory tools via Model Context Protocol for cross-agent access:

```typescript
import { startMcpServer } from "mem-c";

// Start MCP server on stdio
await startMcpServer({ dbPath: "./memory.db" });
// 9 tools available: memory_search, memory_store, memory_detail, etc.
```

## Multi-User Namespace Isolation (v0.6+)

Scope data per user with namespace:

```typescript
import { MemoryGraphEngine } from "mem-c";

const user1 = new MemoryGraphEngine(db, { namespace: "user-123" });
const user2 = new MemoryGraphEngine(db, { namespace: "user-456" });

user1.upsertEntity({ name: "Private", type: "concept" });
user2.findEntities({ name: "Private" }); // → [] (isolated)
```

## Event-Driven API (v0.6+)

Subscribe to graph mutations:

```typescript
const engine = new MemoryGraphEngine(db);
engine.getEvents().on("entity:created", (entity) => {
  console.log("New entity:", entity.name);
});
engine.getEvents().on("edge:created", (edge) => {
  console.log("New edge:", edge.relation);
});
```

## REST API (v0.6+)

HTTP interface for non-Node.js consumers:

```typescript
import { startRestServer } from "mem-c";

const { port, close } = await startRestServer({ port: 3000 });
// GET  /search?q=...     — hybrid search
// POST /entities         — create entity
// GET  /entities/:name   — entity detail
// GET  /communities      — detect communities
// GET  /paths?from=X&to=Y — path finding
// GET  /export?format=mermaid — graph export
// GET  /health           — server stats
```

## Requirements

- Node.js >= 22.0.0 (for built-in `node:sqlite`)

## CI

GitHub Actions verifies `npm test`, `npm run typecheck`, and `npm run build` on Node 22 and Node 24 for every PR and every push to `main`.

## License

MIT
