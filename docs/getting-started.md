# Getting Started with openclaw-memory

## Installation

```bash
npm install openclaw-memory
```

**Requirements:** Node.js >= 22.0.0 (for built-in `node:sqlite`)

## Basic Usage

### 1. Initialize the database

```typescript
import { DatabaseSync } from "node:sqlite";
import { ensureGraphSchema, MemoryGraphEngine } from "openclaw-memory";

const db = new DatabaseSync("memory.db", { allowExtension: true });
const { entityFtsAvailable, vecAvailable } = ensureGraphSchema({ db });
console.log(`FTS: ${entityFtsAvailable}, Vec: ${vecAvailable}`);

const engine = new MemoryGraphEngine(db);
```

The schema is created automatically on first run. FTS5 full-text search and sqlite-vec ANN index are enabled when the respective extensions are available — no extra configuration needed.

### 2. Store knowledge

```typescript
// Create entities
const alice = engine.upsertEntity({
  name: "Alice",
  type: "user",
  summary: "Lead engineer on ProjectX",
});

const project = engine.upsertEntity({
  name: "ProjectX",
  type: "project",
  summary: "Next-gen search engine",
});

// Create relationships (auto-deduplicates)
engine.addEdge({
  fromId: alice.id,
  toId: project.id,
  relation: "works_on",
});

// Store a decision
const decision = engine.upsertEntity({
  name: "Use SQLite for storage",
  type: "decision",
  summary: "Chose SQLite over PostgreSQL for zero-infrastructure deployment",
  confidence: 0.9,
});

engine.addEdge({
  fromId: decision.id,
  toId: project.id,
  relation: "decided",
});
```

### 3. Search the graph

```typescript
import { searchGraph } from "openclaw-memory";

const results = searchGraph(db, engine, "Alice's projects");
console.log(results[0]?.entity.name);  // "Alice"
console.log(results[0]?.score);        // 0.85
console.log(results[0]?.relatedNames); // ["ProjectX"]
```

Search uses a hybrid scoring algorithm: vector similarity + FTS5 relevance + graph connectivity + temporal decay. If you provide an `embedFn`, query embeddings are generated automatically.

### 4. Get context for an LLM prompt

```typescript
import {
  buildL0Context,
  buildL1Context,
  buildL2Context,
  formatL0AsPromptSection,
  formatL1AsSearchContext,
  formatL2AsDetail,
} from "openclaw-memory";

// L0: lightweight entity roster (~200 tokens, every request)
const l0 = buildL0Context(engine, { maxTokens: 200, useImportance: true });
const systemSection = formatL0AsPromptSection(l0);

// L1: search-triggered context (~800 tokens)
const l1 = buildL1Context(db, engine, "what is Alice working on?");
const searchContext = formatL1AsSearchContext(l1);

// L2: full entity detail (~2000 tokens, on-demand)
const l2 = buildL2Context(engine, alice.id, { includeEpisodes: true });
const detail = formatL2AsDetail(l2);
```

### 5. Import documents

```typescript
import { importDocument, markdownParser } from "openclaw-memory";
import fs from "node:fs";

const result = await importDocument(engine, {
  content: fs.readFileSync("./docs/architecture.md", "utf-8"),
  parser: markdownParser,
  llmExtract: async ({ systemPrompt, userPrompt }) => {
    // Call your LLM here — return a JSON string matching the extraction schema
    return await callYourLLM(systemPrompt, userPrompt);
  },
  chunkSize: 2000,
  sourceType: "markdown",
});
console.log(`Imported: ${result.entitiesCreated} entities, ${result.edgesCreated} edges`);
```

Other built-in parsers: `textParser` (plain text), `pdfParser(extractText)` (PDF with custom extractor), `feishuParser(fetchContent)` (Feishu docs with custom fetcher).

### 6. Use with MCP (Claude Desktop / cross-agent)

```typescript
import { startMcpServer } from "openclaw-memory";

// Connects via stdio — use with Claude Desktop or any MCP client
await startMcpServer({ dbPath: "./memory.db" });
```

This exposes 9 memory tools over Model Context Protocol: `memory_search`, `memory_store`, `memory_detail`, `memory_graph`, `memory_invalidate`, `memory_consolidate`, `memory_batch_store`, `memory_communities`, `memory_paths`.

### 7. Multi-user isolation

```typescript
const user1 = new MemoryGraphEngine(db, { namespace: "user-123" });
const user2 = new MemoryGraphEngine(db, { namespace: "user-456" });

user1.upsertEntity({ name: "Private", type: "concept" });
user2.findEntities({ name: "Private" }); // → [] (isolated)
```

All operations (entities, edges, episodes) are scoped to the namespace. Different users sharing the same database file never see each other's data.

### 8. Backup and restore

```typescript
import { createBackup, writeBackup, readBackup, restoreBackup } from "openclaw-memory";

// Full backup
const backup = createBackup(engine);
await writeBackup(backup, "./backup-2026-04-28.json");

// Incremental backup (only changes since timestamp)
const { createIncrementalBackup } = await import("openclaw-memory");
const incremental = createIncrementalBackup(engine, lastBackupTimestamp);
await writeBackup(incremental, "./backup-incremental.json");

// Restore
const data = await readBackup("./backup-2026-04-28.json");
const result = restoreBackup(newEngine, data);
console.log(`Restored: ${result.entitiesRestored} entities, ${result.edgesRestored} edges`);

// Point-in-time restore (e.g., restore to yesterday)
const data2 = await readBackup("./backup-2026-04-28.json");
restoreBackup(newEngine, data2, { pointInTime: Date.now() - 86400000 });
```

### 9. Subscribe to events

```typescript
const events = engine.getEvents();

events.on("entity:created", (entity) => {
  console.log(`New entity: ${entity.name} (${entity.type})`);
});

events.on("edge:created", (edge) => {
  console.log(`New edge: ${edge.relation}`);
});

events.on("communities:detected", (count) => {
  console.log(`Found ${count} communities`);
});
```

### 10. REST API for non-Node.js consumers

```typescript
import { startRestServer } from "openclaw-memory";

const { port, close } = await startRestServer({ port: 3000 });
console.log(`Memory API running on http://localhost:${port}`);

// Available endpoints:
// GET  /search?q=...
// POST /entities
// GET  /entities/:name
// GET  /communities
// GET  /paths?from=X&to=Y
// GET  /export?format=mermaid
// GET  /health
```

## Next Steps

- [API Reference](./api-reference.md) — complete documentation for every exported function and type
- [README](../README.md) — features, architecture, and examples
