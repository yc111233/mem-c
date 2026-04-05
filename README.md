# openclaw-memory

Temporal knowledge graph memory system for AI agents — SQLite-based, zero-infrastructure, with hybrid retrieval (vector + FTS + graph traversal).

[中文文档](./README.zh-CN.md)

## Features

- **Temporal versioning** — `valid_from` / `valid_until` on entities and edges; track when facts change
- **Hybrid search** — vector similarity + FTS5 full-text + graph connectivity + time decay scoring
- **Tiered context loading** — L0 (entity roster, ~200 tokens) / L1 (search results, ~800 tokens) / L2 (full detail, ~2000 tokens)
- **Entity importance scoring** — composite metric (recency + degree centrality + access frequency + confidence) for smarter L0 injection
- **Graph consolidation** — automatic merge of duplicates, decay of stale entities, pruning of low-confidence orphans
- **Compaction-aware** — pre-compaction extraction hooks and post-compaction L0 boost to prevent knowledge loss
- **LLM extraction** — automatic entity/relation extraction from conversation transcripts
- **Markdown migration** — import existing MEMORY.md / memory/*.md files into the graph
- **Zero infrastructure** — pure `node:sqlite` (Node 22+), no external databases

## Install

```bash
npm install openclaw-memory
```

## Architecture

```
src/host/
├── graph-schema.ts         # SQLite DDL + FTS5 virtual table
├── graph-engine.ts         # CRUD + graph traversal + temporal versioning + importance scoring
├── graph-search.ts         # Hybrid retrieval (vector + FTS + graph + time decay)
├── graph-context-loader.ts # L0/L1/L2 tiered context loading (query-aware, importance-aware)
├── graph-consolidator.ts   # Graph hygiene: merge duplicates, decay stale, prune orphans
├── graph-extractor.ts      # LLM entity/relation extraction
├── graph-migrate.ts        # Markdown memory → graph migration
└── graph-tools.ts          # Agent tool interfaces
```

## Quick Start

```typescript
import { DatabaseSync } from "node:sqlite";
import { ensureGraphSchema, MemoryGraphEngine, searchGraph } from "openclaw-memory";

// Initialize
const db = new DatabaseSync("memory.db");
const { entityFtsAvailable } = ensureGraphSchema({ db });
const engine = new MemoryGraphEngine(db);

// Store entities
const user = engine.upsertEntity({ name: "Alice", type: "user", summary: "Lead engineer" });
const project = engine.upsertEntity({ name: "GraphDB", type: "project", summary: "Graph database project" });

// Create relationships
engine.addEdge({ fromId: user.id, toId: project.id, relation: "works_on" });

// Search
const results = searchGraph(db, engine, "Alice project");
console.log(results[0]?.entity.name, results[0]?.score);

// Temporal: invalidate outdated facts
engine.invalidateEntity(project.id, "project completed");
const history = engine.getEntityHistory("GraphDB"); // see all versions
```

## Context Tiers

| Tier | Purpose | Token Budget | When Used |
|------|---------|-------------|-----------|
| **L0** | Entity roster for system prompt | ~200 | Every request |
| **L1** | Search-triggered summaries + relations | ~800 | On memory search |
| **L2** | Full entity detail + history + episodes | ~2000 | On-demand drill-down |

```typescript
import { buildL0Context, buildL1Context, buildL2Context, formatL0AsPromptSection } from "openclaw-memory";

const l0 = buildL0Context(engine, { maxTokens: 200 });
const systemPromptSection = formatL0AsPromptSection(l0);

const l1 = buildL1Context(db, engine, "user query here");
const l2 = buildL2Context(engine, entityId);
```

## LLM Extraction

Extraction requires a `llmExtract` callback — the host runtime must provide this function
(openclaw-memory does not bundle any LLM client). The OpenClaw plugin receives it via the
`agent_end` event; standalone users must supply it directly:

```typescript
import { extractAndMerge } from "openclaw-memory";

const result = await extractAndMerge({
  engine,
  transcript: "User discussed switching from REST to GraphQL...",
  sessionKey: "session-123",
  llmExtract: async ({ systemPrompt, userPrompt }) => {
    // Call your LLM here, return JSON string
    return await callLLM(systemPrompt, userPrompt);
  },
});
// result: { entitiesCreated: 2, edgesCreated: 1, ... }
```

## Agent Tools

Six pre-built tool functions for agent integration:

| Tool | Function | Purpose |
|------|----------|---------|
| `memoryGraphSearch` | Hybrid search | Find relevant entities |
| `memoryStore` | Create/update entity | Store facts with relations |
| `memoryDetail` | L2 context | Get full entity detail |
| `memoryGraph` | Graph visualization | Show entity relationships |
| `memoryInvalidate` | Soft delete | Mark facts as outdated |
| `memoryConsolidate` | Graph hygiene | Merge duplicates, decay stale, prune orphans |

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
import { consolidateGraph } from "openclaw-memory";

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

## Migration from Markdown

```typescript
import { migrateMarkdownMemory } from "openclaw-memory";

const result = await migrateMarkdownMemory({
  engine,
  workspaceDir: "/path/to/workspace",
});
// Imports memory/*.md files with frontmatter into the graph
```

## OpenViking Synergy

This library complements [OpenViking](https://github.com/nicepkg/openviking) — use both together:

| Query Type | Best Tool |
|-----------|-----------|
| "Find similar conversations" | OpenViking vector search |
| "Alice's projects and decisions?" | Graph traversal |
| "When did this fact change?" | Temporal version history |

Both use SQLite and can share the same database directory.

## Requirements

- Node.js >= 22.0.0 (for built-in `node:sqlite`)

## License

MIT
