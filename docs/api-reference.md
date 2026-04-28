# mem-c API Reference

Complete API documentation for `mem-c` v1.0.0.

## Table of Contents

- [Setup](#setup)
- [Engine (MemoryGraphEngine)](#engine)
- [Hybrid Search](#hybrid-search)
- [Tiered Context Loading](#tiered-context-loading)
- [Graph Consolidation](#graph-consolidation)
- [LLM Extraction](#llm-extraction)
- [Markdown Migration](#markdown-migration)
- [Document Import](#document-import)
- [Document Parsers](#document-parsers)
- [Community Detection](#community-detection)
- [Relation Inference](#relation-inference)
- [Graph Export](#graph-export)
- [Backup & Restore](#backup--restore)
- [MCP Server](#mcp-server)
- [REST API](#rest-api)
- [Event System](#event-system)
- [Agent Tools](#agent-tools)
- [sqlite-vec ANN Index](#sqlite-vec-ann-index)
- [Types Reference](#types-reference)

---

## Setup

### `ensureGraphSchema(params)`

Initialize the database schema. Call once on startup.

```typescript
function ensureGraphSchema(params: {
  db: DatabaseSync;
  ftsEnabled?: boolean;
  engine?: MemoryGraphEngine;
  vecDimensions?: number;
}): {
  entityFtsAvailable: boolean;
  entityFtsError?: string;
  vecAvailable: boolean;
  vecError?: string;
};
```

**Params:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `db` | `DatabaseSync` | — | SQLite database instance |
| `ftsEnabled` | `boolean` | `true` | Enable FTS5 full-text search |
| `engine` | `MemoryGraphEngine` | — | Engine instance for vec availability wiring |
| `vecDimensions` | `number` | `1536` | Embedding dimensions for sqlite-vec |

**Returns:** Object indicating whether FTS and vec are available, plus any initialization errors.

**Behavior:**
- Sets `PRAGMA journal_mode = WAL` and `PRAGMA busy_timeout = 5000` for multi-process safety.
- Creates all tables (`entities`, `edges`, `episodes`, `entity_aliases`, `communities`, `community_members`, `import_sessions`) if they don't exist.
- Creates FTS5 virtual table if `ftsEnabled` is true and sqlite3 FTS5 is available.
- Creates vec0 virtual table if sqlite-vec extension is loadable.
- Auto-migrates existing TEXT embeddings to BLOB format.

---

### FTS Helpers

```typescript
function syncEntityFts(
  db: DatabaseSync,
  entity: Pick<EntityRow, "id" | "name" | "summary">,
): void;
```
Sync an entity row into the FTS index (upsert). Called automatically by `upsertEntity`.

```typescript
function removeEntityFts(db: DatabaseSync, entityId: string): void;
```
Remove an entity from the FTS index.

```typescript
function sanitizeFtsQuery(query: string): string;
```
Sanitize a user query for FTS5 MATCH. Strips special FTS5 operators (`"`, `*`, `(`, `)`, `^`, `-`, `+`, `NEAR`, `OR`, `AND`, `NOT`) to prevent crashes.

```typescript
function searchEntityFts(
  db: DatabaseSync,
  query: string,
  opts?: { limit?: number; activeOnly?: boolean },
): Array<{ id: string; rank: number }>;
```
Full-text search over entity names and summaries.

---

## Engine

### `MemoryGraphEngine`

Core engine class for all graph operations.

```typescript
class MemoryGraphEngine {
  constructor(db: DatabaseSync, opts?: MemoryGraphEngineOpts);
}
```

**Constructor Options (`MemoryGraphEngineOpts`):**

| Param | Type | Description |
|-------|------|-------------|
| `embedFn` | `(text: string) => number[]` | Auto-generate embeddings for entities and search queries |
| `namespace` | `string` | Multi-user isolation namespace — all queries scoped to this namespace |

#### Entity CRUD

##### `upsertEntity(input)`

Create or update an entity. If an entity with the same normalized name and type exists, updates it; otherwise creates a new one. Auto-generates embedding if `embedFn` is configured and content changed.

```typescript
upsertEntity(input: EntityInput): Entity & { isNew: boolean };
```

**Input (`EntityInput`):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | Entity name (auto-normalized for matching) |
| `type` | `EntityType` | yes | Entity type (user, project, concept, file, decision, feedback, tool, preference, or custom string) |
| `summary` | `string` | no | Human-readable description |
| `embedding` | `number[]` | no | Pre-computed embedding vector |
| `confidence` | `number` | no | Confidence score 0-1 (default: 0.8) |
| `source` | `EntitySource` | no | Origin: "auto", "manual", or "imported" (default: "manual") |
| `validFrom` | `number` | no | Custom valid_from timestamp (default: now) |

**Returns:** The entity with `isNew: true` if created, `isNew: false` if updated.

##### `getEntity(id)`

```typescript
getEntity(id: string): Entity | null;
```
Get an entity by ID. Returns null if not found.

##### `findEntities(query)`

```typescript
findEntities(query: EntityQuery): Entity[];
```

**Query (`EntityQuery`):**

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Match by name (case-insensitive, checks aliases) |
| `type` | `EntityType` | Filter by type |
| `activeOnly` | `boolean` | Only currently-valid entities (default: true) |
| `limit` | `number` | Max results |

##### `invalidateEntity(id, reason?)`

```typescript
invalidateEntity(id: string, reason?: string): void;
```
Soft-delete an entity. Sets `valid_until` to now. The entity remains in the database for history queries. Edges connected to this entity are also invalidated.

##### `touchEntity(id)`

```typescript
touchEntity(id: string): void;
```
Increment access counter and update `last_accessed_at`. Called automatically by search and detail operations.

##### `updateConfidence(id, confidence)`

```typescript
updateConfidence(id: string, confidence: number): void;
```
Update confidence score for an entity. Used by the consolidation pipeline.

##### `addAlias(entityId, alias)`

```typescript
addAlias(entityId: string, alias: string): void;
```
Add a custom alias for an entity. Enables finding the entity by alternative names.

##### `reassignEdges(fromEntityId, toEntityId)`

```typescript
reassignEdges(fromEntityId: string, toEntityId: string): number;
```
Reassign all active edges from one entity to another. Returns count of reassigned edges. Used during entity merge.

##### `getEntitiesByImportance(opts?)`

```typescript
getEntitiesByImportance(opts?: {
  limit?: number;
  type?: EntityType;
  activeOnly?: boolean;
}): Entity[];
```
Get active entities sorted by importance score. Importance = 0.3 x recency + 0.3 x degree centrality + 0.25 x access frequency + 0.15 x confidence.

##### `getEntityHistory(name)`

```typescript
getEntityHistory(name: string): EntityVersion[];
```
Get all versions (active and invalidated) of an entity by name.

##### `getActiveEntities(type?)`

```typescript
getActiveEntities(type?: EntityType): Entity[];
```
Get all currently-valid entities, optionally filtered by type.

#### Edge CRUD

##### `addEdge(input)`

Create or update an edge. If an active edge with the same `(from_id, to_id, relation)` exists, updates its weight instead of creating a duplicate.

```typescript
addEdge(input: EdgeInput): Edge;
```

**Input (`EdgeInput`):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fromId` | `string` | yes | Source entity ID |
| `toId` | `string` | yes | Target entity ID |
| `relation` | `string` | yes | Relationship type (e.g., "works_on", "decided", "prefers") |
| `weight` | `number` | no | Edge weight (default: 1.0) |
| `metadata` | `Record<string, unknown>` | no | Arbitrary metadata |
| `validFrom` | `number` | no | Custom valid_from timestamp (default: now) |

##### `findEdges(query)`

```typescript
findEdges(query: EdgeQuery): Edge[];
```

**Query (`EdgeQuery`):**

| Field | Type | Description |
|-------|------|-------------|
| `entityId` | `string` | Find edges connected to this entity |
| `relation` | `string` | Filter by relation type |
| `direction` | `"outgoing" \| "incoming" \| "both"` | Edge direction (default: "both") |
| `activeOnly` | `boolean` | Only active edges (default: true) |
| `limit` | `number` | Max results |

##### `invalidateEdge(id)`

```typescript
invalidateEdge(id: string): void;
```
Soft-delete an edge by setting `valid_until` to now.

#### Batch Operations

##### `upsertEntities(inputs)`

```typescript
upsertEntities(inputs: EntityInput[]): Array<Entity & { isNew: boolean }>;
```
Batch upsert multiple entities in a single transaction.

##### `addEdges(inputs)`

```typescript
addEdges(inputs: EdgeInput[]): Edge[];
```
Batch create multiple edges in a single transaction.

#### Graph Traversal

##### `getNeighbors(entityId, depth?)`

```typescript
getNeighbors(entityId: string, depth?: number): GraphSubset;
```
Get entities and edges within `depth` hops of the given entity. Default depth: 1. Uses BFS.

##### `findPaths(fromId, toId, opts?)`

```typescript
findPaths(
  fromId: string,
  toId: string,
  opts?: FindPathsOpts,
): PathResult[];
```
Find all paths between two entities up to `maxDepth` hops via BFS with cycle detection.

**Options (`FindPathsOpts`):**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxDepth` | `number` | `3` | Maximum BFS depth |
| `maxPaths` | `number` | `10` | Maximum paths to return |

**Returns:** Array of `PathResult`, each containing `steps: PathStep[]` and `length: number`.

#### Episodes

##### `recordEpisode(input)`

```typescript
recordEpisode(input: EpisodeInput): EpisodeRow;
```

**Input (`EpisodeInput`):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sessionKey` | `string` | yes | Session identifier |
| `turnIndex` | `number` | no | Turn number within session |
| `content` | `string` | yes | Episode content |
| `extractedEntityIds` | `string[]` | no | Entity IDs mentioned in this episode |

##### `getEpisodes(sessionKey, limit?)`

```typescript
getEpisodes(sessionKey: string, limit?: number): EpisodeRow[];
```
Get episodes for a session. Default limit: 50.

#### Transactions & Accessors

##### `runInTransaction(fn)`

```typescript
runInTransaction<T>(fn: () => T): T;
```
Run a function inside a SQLite transaction. Supports nesting (inner calls are no-ops).

##### `getDb()`

```typescript
getDb(): DatabaseSync;
```
Get the underlying database for advanced queries.

##### `getEmbedFn()`

```typescript
getEmbedFn(): EmbedFn | undefined;
```
Get the configured embedding function.

##### `getEvents()`

```typescript
getEvents(): GraphEventEmitter;
```
Get the event emitter for subscribing to graph lifecycle events.

##### `setVecAvailable(available)`

```typescript
setVecAvailable(available: boolean): void;
```
Manually set whether the vec index is available. Usually called by `ensureGraphSchema`.

##### `vecAvailable()`

```typescript
vecAvailable(): boolean;
```
Check if the vec ANN index is available.

##### `stats()`

```typescript
stats(): {
  entities: number;
  edges: number;
  episodes: number;
  activeEntities: number;
};
```
Get entity/edge/episode counts.

---

### Standalone Engine Functions

```typescript
function computeImportance(
  entity: Entity,
  edgeCount: number,
  now: number,
): number;
```
Compute a composite importance score. Formula: `0.3 * recency + 0.3 * degree + 0.25 * accessScore + 0.15 * confidence`.

```typescript
function serializeEmbedding(vec: number[]): Buffer;
function deserializeEmbedding(blob: Buffer): number[];
```
Convert between embedding arrays and binary BLOB storage.

```typescript
function normalizeEntityName(name: string): string;
```
Normalize an entity name for case-insensitive matching (lowercase, trimmed).

---

## Hybrid Search

### `searchGraph(db, engine, query, opts?)`

Hybrid search combining vector similarity, FTS5 full-text, graph connectivity, and temporal decay.

```typescript
function searchGraph(
  db: DatabaseSync,
  engine: MemoryGraphEngine,
  query: string,
  opts?: GraphSearchOpts,
): GraphSearchResult[];
```

**Options (`GraphSearchOpts`):**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxResults` | `number` | `10` | Max results to return |
| `minScore` | `number` | `0.1` | Minimum relevance score (0-1) |
| `types` | `string[]` | — | Entity types to include (undefined = all) |
| `activeOnly` | `boolean` | `true` | Only currently-valid entities |
| `includeEdges` | `boolean` | `true` | Include related edges in each result |
| `graphDepth` | `number` | `1` | Max BFS depth for graph expansion |
| `vectorWeight` | `number` | `0.5` | Weight for vector similarity score |
| `ftsWeight` | `number` | `0.3` | Weight for FTS score |
| `graphWeight` | `number` | `0.2` | Weight for graph connectivity score |
| `temporalDecayDays` | `number` | `30` | Temporal decay half-life in days (0 = no decay) |
| `queryEmbedding` | `number[]` | — | Pre-computed query embedding (auto-generated if `embedFn` configured) |
| `cacheTtlMs` | `number` | `30000` | Cache TTL in ms (0 = no cache) |

**Returns (`GraphSearchResult[]`):**

```typescript
{
  entity: Entity;
  score: number;              // Composite score 0-1
  scoreBreakdown: {
    vector: number;           // Vector similarity component
    fts: number;              // FTS relevance component
    graph: number;            // Graph connectivity component
    temporal: number;         // Temporal decay component
  };
  edges: Edge[];              // Related edges (if includeEdges: true)
  relatedNames: string[];     // 1-hop neighbor names
}
```

**Scoring:** `score = vectorWeight * vector + ftsWeight * fts + graphWeight * graph + temporal * temporalDecay`. Results are diversity-filtered to avoid near-duplicate entities.

### `clearSearchCache()`

```typescript
function clearSearchCache(): void;
```
Clear the search result cache. Called automatically on entity writes.

---

## Tiered Context Loading

Three tiers for efficient token budget management:

| Tier | Purpose | Budget | When Used |
|------|---------|--------|-----------|
| **L0** | Entity roster for system prompt | ~200 tokens | Every request |
| **L1** | Search-triggered summaries + relations | ~800 tokens | On memory search |
| **L2** | Full entity detail + history + episodes | ~2000 tokens | On-demand drill-down |

### `suggestBudgets(availableTokens)`

```typescript
function suggestBudgets(availableTokens: number): ContextBudget;
```
Allocate L0/L1/L2 token budgets based on available capacity. Three regimes:
- Comfortable (>=3000): standard 200/800/2000
- Tight (500-2999): proportional compression
- Extreme (<500): minimal L0, residual L1, no L2

### `buildL0Context(engine, opts?)`

```typescript
function buildL0Context(
  engine: MemoryGraphEngine,
  opts?: { maxTokens?: number; useImportance?: boolean },
): L0Context;
```
Build a lightweight entity roster for system prompt injection. Lists active entity names and types. When `useImportance: true`, ranks by importance score.

### `buildQueryAwareL0Context(db, engine, query, opts?)`

```typescript
function buildQueryAwareL0Context(
  db: DatabaseSync,
  engine: MemoryGraphEngine,
  query: string,
  opts?: { maxTokens?: number; maxEntities?: number },
): L0Context;
```
Build an L0 roster that prioritizes entities relevant to the user's query. Runs a lightweight search first, then fills remaining budget with importance-ranked entities.

### `buildL1Context(db, engine, query, opts?)`

```typescript
function buildL1Context(
  db: DatabaseSync,
  engine: MemoryGraphEngine,
  query: string,
  opts?: { maxTokens?: number; maxResults?: number },
): L1Context;
```
Build search-triggered context with entity summaries and key relationships.

### `buildL2Context(engine, entityId, opts?)`

```typescript
function buildL2Context(
  engine: MemoryGraphEngine,
  entityId: string,
  opts?: { detailLevel?: L2DetailLevel; maxTokens?: number; includeEpisodes?: boolean; maxEpisodes?: number },
): L2Context;
```
Build full detail context for a specific entity. Includes complete entity data, all edges, and related episodes.

### Formatting Functions

```typescript
function formatL0AsPromptSection(l0: L0Context): string;
```
Format L0 context as a prompt section string (e.g., "Known entities:\n- Alice (user)\n- ProjectX (project)").

```typescript
function formatL1AsSearchContext(l1: L1Context): string;
```
Format L1 context as a string suitable for tool result injection.

```typescript
function formatL2AsDetail(l2: L2Context): string;
```
Format L2 context as a detailed view string with entity data, relationships, and episode history.

---

## Graph Consolidation

### `consolidateGraph(engine, opts?)`

Periodic cleanup to maintain graph hygiene. Runs three phases in a single transaction:

1. **Merge** — same-name entities with different types keep highest confidence
2. **Decay** — reduce confidence of entities not accessed for N days
3. **Prune** — invalidate low-confidence orphans (no edges, below threshold)

```typescript
function consolidateGraph(
  engine: MemoryGraphEngine,
  opts?: ConsolidationOpts,
): ConsolidationResult;
```

**Options (`ConsolidationOpts`):**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `decayAfterDays` | `number` | `30` | Entities not accessed for this many days get decayed |
| `pruneThreshold` | `number` | `0.3` | Orphan entities below this confidence get pruned |
| `enableMerge` | `boolean` | `true` | Enable same-name entity merge |
| `dryRun` | `boolean` | `false` | Report what would happen without modifying |

**Returns (`ConsolidationResult`):**

```typescript
{
  merged: number;
  decayed: number;
  pruned: number;
  errors: string[];
}
```

---

## LLM Extraction

### `extractAndMerge(params)`

Run LLM extraction on a conversation transcript and merge results into the graph. This is the main entry point for memory flush.

```typescript
async function extractAndMerge(params: {
  engine: MemoryGraphEngine;
  transcript: string;
  sessionKey: string;
  turnIndex?: number;
  llmExtract: LlmExtractFn;
  existingEntityNames?: string[];
}): Promise<ExtractAndMergeResult>;
```

**LLM callback (`LlmExtractFn`):**

```typescript
type LlmExtractFn = (params: {
  systemPrompt: string;
  userPrompt: string;
}) => Promise<string>;
```

The caller provides this function. mem-c does not bundle any LLM client.

**Returns (`ExtractAndMergeResult`):**

```typescript
{
  entitiesCreated: number;
  entitiesUpdated: number;
  edgesCreated: number;
  invalidated: number;
  episodeRecorded: boolean;
  errors: string[];
}
```

### `buildExtractionUserPrompt(transcript, existingEntityNames?)`

```typescript
function buildExtractionUserPrompt(
  transcript: string,
  existingEntityNames?: string[],
): string;
```
Build the user prompt for the extraction LLM call. Includes known entity names for deduplication when provided.

### `EXTRACTION_SYSTEM_PROMPT`

The system prompt constant used for extraction. Defines the JSON schema for extraction output (entities, relations, invalidations).

---

## Markdown Migration

### `migrateMarkdownMemory(params)`

Import markdown memory files from a workspace directory into the graph. Reads `memory/*.md` files with frontmatter.

```typescript
async function migrateMarkdownMemory(params: {
  engine: MemoryGraphEngine;
  workspaceDir: string;
}): Promise<MigrationResult>;
```

**Returns (`MigrationResult`):**

```typescript
{
  filesProcessed: number;
  entitiesCreated: number;
  entitiesUpdated: number;
  errors: string[];
}
```

---

## Document Import

### `importDocument(engine, opts)`

Unified API for importing documents into the knowledge graph. Pipeline: parse -> smart chunk -> LLM extract -> merge.

```typescript
async function importDocument(
  engine: MemoryGraphEngine,
  opts: ImportOpts,
): Promise<ImportResult>;
```

**Options (`ImportOpts`):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | `string` | yes | Document content |
| `parser` | `DocumentParser` | yes | Parser function |
| `llmExtract` | `LlmExtractFn` | yes | LLM extraction callback |
| `sessionKey` | `string` | no | Session identifier |
| `chunkSize` | `number` | no | Max tokens per chunk (default: 2000) |
| `importSessionId` | `string` | no | Existing session ID for resume tracking |
| `sourceType` | `string` | no | Source type label (e.g., "markdown", "pdf") |
| `sourcePath` | `string` | no | Source file path for tracking |

**Returns (`ImportResult`):**

```typescript
{
  sessionId: string;
  chunksProcessed: number;
  entitiesCreated: number;
  entitiesUpdated: number;
  edgesCreated: number;
  errors: string[];
}
```

### `smartChunk(text, maxChunkChars?)`

Split text into chunks respecting semantic boundaries. Priority: paragraph breaks > sentence boundaries > hard cut.

```typescript
function smartChunk(text: string, maxChunkChars?: number): string[];
```
Default max chunk size: 8000 characters.

### `batchChatImport(engine, sessions, opts)`

Import multiple chat sessions into the graph.

```typescript
async function batchChatImport(
  engine: MemoryGraphEngine,
  sessions: ChatMessage[][],
  opts: BatchImportOpts,
): Promise<BatchImportResult>;
```

**Chat message:**

```typescript
type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: number;
};
```

**Batch options (`BatchImportOpts`):**

| Field | Type | Description |
|-------|------|-------------|
| `llmExtract` | `LlmExtractFn` | LLM extraction callback |
| `sessionKeyPrefix` | `string` | Prefix for session keys |

**Returns (`BatchImportResult`):**

```typescript
{
  sessionsProcessed: number;
  totalEntitiesCreated: number;
  totalEntitiesUpdated: number;
  totalEdgesCreated: number;
  errors: string[];
}
```

### Import Session Tracking

```typescript
function createImportSession(
  db: DatabaseSync,
  sourceType: string,
  sourcePath?: string,
): ImportSession;

function updateImportSession(
  db: DatabaseSync,
  id: string,
  updates: Partial<Pick<ImportSession, "status" | "totalChunks" | "processedChunks" | "entitiesCreated" | "entitiesUpdated" | "edgesCreated" | "errorCount" | "lastChunkIndex">>,
): void;

function getImportSession(db: DatabaseSync, id: string): ImportSession | null;

function listImportSessions(db: DatabaseSync): ImportSession[];
```

Track import progress with sessions stored in the `import_sessions` table.

---

## Document Parsers

### `markdownParser`

```typescript
function markdownParser(content: string): DocumentChunk[];
```
Parse markdown content into chunks based on heading structure. Each section under a heading becomes a chunk.

### `textParser`

```typescript
function textParser(content: string): DocumentChunk[];
```
Simple text parser — treats entire content as a single chunk.

### `pdfParser`

```typescript
function pdfParser(
  extractText: (content: string) => Promise<string>,
): (content: string) => Promise<DocumentChunk[]>;
```
Factory for PDF parser. The caller provides a function that extracts text from PDF content. Splits on page breaks.

### `feishuParser`

```typescript
function feishuParser(
  fetchContent: (url: string) => Promise<string>,
): (url: string) => Promise<DocumentChunk[]>;
```
Factory for Feishu document parser. The caller provides a function that fetches content from a Feishu URL. Delegates to markdown parser.

---

## Community Detection

### `detectCommunities(engine, opts?)`

Detect communities in the graph using BFS connected components.

```typescript
function detectCommunities(
  engine: MemoryGraphEngine,
  opts?: DetectionOpts,
): DetectionResult;
```

**Options (`DetectionOpts`):**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `activeOnly` | `boolean` | `true` | Only consider active entities |
| `maxCommunitySize` | `number` | `1000` | Max community size to track |

**Returns (`DetectionResult`):**

```typescript
{
  communities: Community[];
  totalEntities: number;
}
```

### `getCommunities(engine)`

```typescript
function getCommunities(engine: MemoryGraphEngine): Community[];
```
Get all stored communities, sorted by entity count descending.

### `getCommunityForEntity(engine, entityId)`

```typescript
function getCommunityForEntity(
  engine: MemoryGraphEngine,
  entityId: string,
): Community | null;
```
Get the community containing a specific entity.

### `summarizeCommunities(engine, summarizeFn)`

```typescript
async function summarizeCommunities(
  engine: MemoryGraphEngine,
  summarizeFn: SummarizeFn,
): Promise<{ summarized: number; errors: string[] }>;
```
Run an LLM summarize function on each community to generate labels. Stored in `communities.label`.

**Summarize callback:**

```typescript
type SummarizeFn = (params: {
  entities: Array<{ name: string; type: string; summary: string | null }>;
  relations: Array<{ from: string; to: string; relation: string }>;
}) => Promise<string>;
```

### `COMMUNITY_SUMMARY_PROMPT`

System prompt constant for community summarization.

---

## Relation Inference

### `inferRelationTypes(engine, inferFn, opts?)`

Analyze edges with generic relation types and suggest richer alternatives. Does not modify the graph — call `applySuggestions()` on the result to apply.

```typescript
async function inferRelationTypes(
  engine: MemoryGraphEngine,
  inferFn: InferRelationFn,
  opts?: InferenceOpts,
): Promise<InferenceResult>;
```

**Inference callback (`InferRelationFn`):**

```typescript
type InferRelationFn = (params: {
  fromName: string;
  fromType: string;
  fromSummary: string | null;
  toName: string;
  toType: string;
  toSummary: string | null;
  currentRelation: string;
}) => Promise<{ relation: string; confidence: number; reason?: string }>;
```

**Options (`InferenceOpts`):**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `targetRelations` | `string[]` | generic types | Only analyze edges with these relation types |
| `maxEdges` | `number` | `50` | Max edges to analyze |
| `minConfidence` | `number` | `0.5` | Min confidence to include in suggestions |

**Returns (`InferenceResult`):**

```typescript
{
  analyzed: number;
  suggestions: InferenceSuggestion[];
  errors: string[];
  applySuggestions: (engine: MemoryGraphEngine) => void;
}
```

---

## Graph Export

### `exportGraph(engine, opts?)`

Export graph data in Mermaid, DOT, or JSON format.

```typescript
function exportGraph(
  engine: MemoryGraphEngine,
  opts?: ExportOpts,
): ExportResult;
```

**Options (`ExportOpts`):**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `format` | `"mermaid" \| "dot" \| "json"` | `"mermaid"` | Output format |
| `centerEntityId` | `string` | — | Center export around this entity (with depth) |
| `depth` | `number` | `2` | BFS depth when centerEntityId is set |
| `maxEntities` | `number` | `100` | Max entities to include |

**Returns (`ExportResult`):**

```typescript
{
  content: string;
  format: ExportFormat;
  entityCount: number;
  edgeCount: number;
}
```

---

## Backup & Restore

### `createBackup(engine)`

Create a full backup of the graph data as an in-memory JSON structure.

```typescript
function createBackup(engine: MemoryGraphEngine): BackupData;
```

### `createIncrementalBackup(engine, sinceTimestamp)`

Create an incremental backup — only records modified since the given timestamp.

```typescript
function createIncrementalBackup(
  engine: MemoryGraphEngine,
  sinceTimestamp: number,
): BackupData;
```

### `writeBackup(data, filePath)`

Write backup data to a JSON file.

```typescript
async function writeBackup(
  data: BackupData,
  filePath: string,
): Promise<BackupResult>;
```

### `readBackup(filePath)`

Read backup data from a JSON file.

```typescript
async function readBackup(filePath: string): Promise<BackupData>;
```

### `restoreBackup(engine, data, opts?)`

Restore graph data from a backup.

```typescript
function restoreBackup(
  engine: MemoryGraphEngine,
  data: BackupData,
  opts?: RestoreOpts,
): RestoreResult;
```

**Restore options (`RestoreOpts`):**

| Field | Type | Description |
|-------|------|-------------|
| `pointInTime` | `number` | Restore only entities/edges valid at this timestamp |
| `overwrite` | `boolean` | Overwrite existing entities with same ID (default: false, skip duplicates) |

**Returns (`RestoreResult`):**

```typescript
{
  entitiesRestored: number;
  edgesRestored: number;
  episodesRestored: number;
  skipped: number;
  errors: string[];
}
```

---

## MCP Server

### `createMemoryMcpServer(opts?)`

Create an MCP server instance exposing all memory tools.

```typescript
function createMemoryMcpServer(opts?: McpServerOpts): {
  server: McpServer;
  engine: MemoryGraphEngine;
  db: DatabaseSync;
};
```

**Options (`McpServerOpts`):**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dbPath` | `string` | `":memory:"` | SQLite database file path |
| `namespace` | `string` | — | Multi-user isolation namespace |
| `embedFn` | `(text: string) => number[]` | — | Embedding function |

**MCP Tools exposed:** `memory_search`, `memory_store`, `memory_detail`, `memory_graph`, `memory_invalidate`, `memory_consolidate`, `memory_batch_store`, `memory_communities`, `memory_paths`.

### `startMcpServer(opts?)`

Start an MCP server on stdio transport.

```typescript
async function startMcpServer(opts?: McpServerOpts): Promise<void>;
```

---

## REST API

### `createRestServer(opts?)`

Create an HTTP server exposing memory operations as REST endpoints.

```typescript
function createRestServer(opts?: RestServerOpts): {
  server: Server;
  engine: MemoryGraphEngine;
  db: DatabaseSync;
};
```

**Options (`RestServerOpts`):**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `port` | `number` | `0` | Port (0 = auto-assign) |
| `host` | `string` | `"localhost"` | Bind host |
| `dbPath` | `string` | `":memory:"` | SQLite database path |
| `namespace` | `string` | — | Namespace for isolation |

**Routes:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/search?q=...` | Hybrid search |
| `POST` | `/entities` | Create entity |
| `GET` | `/entities/:name` | Entity detail |
| `POST` | `/entities/:id/invalidate` | Soft delete |
| `GET` | `/communities` | Detect communities |
| `GET` | `/paths?from=X&to=Y` | Path finding |
| `GET` | `/export?format=mermaid` | Graph export |
| `GET` | `/health` | Server stats |

### `startRestServer(opts?)`

Start the REST server and listen for connections.

```typescript
async function startRestServer(opts?: RestServerOpts): Promise<{
  port: number;
  close: () => void;
}>;
```

---

## Event System

### `GraphEventEmitter`

Type-safe event emitter for graph lifecycle events. Extends Node.js `EventEmitter`.

```typescript
class GraphEventEmitter extends EventEmitter {
  emit<K extends keyof GraphEvents>(event: K, ...args: GraphEvents[K]): boolean;
  on<K extends keyof GraphEvents>(event: K, listener: (...args: GraphEvents[K]) => void): this;
  off<K extends keyof GraphEvents>(event: K, listener: (...args: GraphEvents[K]) => void): this;
}
```

### Events (`GraphEvents`)

| Event | Payload | Description |
|-------|---------|-------------|
| `entity:created` | `[entity: Entity]` | New entity created |
| `entity:updated` | `[entity: Entity]` | Existing entity updated |
| `entity:invalidated` | `[entityId: string]` | Entity soft-deleted |
| `edge:created` | `[edge: Edge]` | New edge created |
| `edge:updated` | `[edge: Edge]` | Existing edge updated (weight merge) |
| `edge:invalidated` | `[edgeId: string]` | Edge soft-deleted |
| `communities:detected` | `[communityCount: number]` | Community detection completed |

---

## Agent Tools

Pre-built tool functions for agent integration. Each wraps lower-level APIs with a consistent input/output pattern.

### `memoryGraphSearch(db, engine, input, queryEmbedding?)`

```typescript
function memoryGraphSearch(
  db: DatabaseSync,
  engine: MemoryGraphEngine,
  input: MemoryGraphSearchInput,
  queryEmbedding?: number[],
): MemoryGraphSearchOutput;
```

### `memoryStore(engine, input)`

```typescript
function memoryStore(
  engine: MemoryGraphEngine,
  input: MemoryStoreInput,
): MemoryStoreOutput;
```

### `memoryBatchStore(engine, input)`

```typescript
function memoryBatchStore(
  engine: MemoryGraphEngine,
  input: MemoryBatchStoreInput,
): MemoryBatchStoreOutput;
```

### `memoryDetail(engine, input)`

```typescript
function memoryDetail(
  engine: MemoryGraphEngine,
  input: MemoryDetailInput,
): MemoryDetailOutput;
```

### `memoryGraph(engine, input)`

```typescript
function memoryGraph(
  engine: MemoryGraphEngine,
  input: MemoryGraphInput,
): MemoryGraphOutput;
```

### `memoryInvalidate(engine, input)`

```typescript
function memoryInvalidate(
  engine: MemoryGraphEngine,
  input: MemoryInvalidateInput,
): MemoryInvalidateOutput;
```

### `memoryConsolidate(engine, input)`

```typescript
function memoryConsolidate(
  engine: MemoryGraphEngine,
  input: MemoryConsolidateInput,
): MemoryConsolidateOutput;
```

### `memoryDetectCommunities(engine, input)`

```typescript
function memoryDetectCommunities(
  engine: MemoryGraphEngine,
  input: MemoryDetectCommunitiesInput,
): MemoryDetectCommunitiesOutput;
```

### `memoryFindPaths(engine, input)`

```typescript
function memoryFindPaths(
  engine: MemoryGraphEngine,
  input: MemoryFindPathsInput,
): MemoryFindPathsOutput;
```

### `memoryExportGraph(engine, input)`

```typescript
function memoryExportGraph(
  engine: MemoryGraphEngine,
  input: MemoryExportGraphInput,
): MemoryExportGraphOutput;
```

### `memorySummarizeCommunities(engine, input)`

```typescript
async function memorySummarizeCommunities(
  engine: MemoryGraphEngine,
  input: MemorySummarizeCommunitiesInput,
): Promise<MemorySummarizeCommunitiesOutput>;
```

### `memoryInferRelations(engine, input)`

```typescript
async function memoryInferRelations(
  engine: MemoryGraphEngine,
  input: MemoryInferRelationsInput,
): Promise<MemoryInferRelationsOutput>;
```

---

## sqlite-vec ANN Index

Optional approximate nearest neighbor search via the `vec0` virtual table. Falls back to full scan when sqlite-vec is not installed.

### `ensureVecIndex(db, dimensions?)`

```typescript
function ensureVecIndex(db: DatabaseSync, dimensions?: number): boolean;
```
Create the vec0 virtual table if sqlite-vec is available. Returns true if successful.

### `vecUpsert(db, entityId, embedding)`

```typescript
function vecUpsert(db: DatabaseSync, entityId: string, embedding: number[]): void;
```
Upsert an entity's embedding into the vec index.

### `vecRemove(db, entityId)`

```typescript
function vecRemove(db: DatabaseSync, entityId: string): void;
```
Remove an entity from the vec index.

### `vecKnn(db, queryEmbedding, limit, activeOnly?)`

```typescript
function vecKnn(
  db: DatabaseSync,
  queryEmbedding: number[],
  limit: number,
  activeOnly?: boolean,
): Array<{ entityId: string; distance: number }>;
```
K-nearest neighbor search.

### `vecSyncAll(db, engine)`

```typescript
function vecSyncAll(db: DatabaseSync, engine: MemoryGraphEngine): number;
```
Sync all active entities to the vec index. Returns count of synced entities.

---

## Types Reference

### Core Entity Types

```typescript
type EntityType = "user" | "project" | "concept" | "file" | "decision"
  | "feedback" | "tool" | "preference" | (string & {});

type EntitySource = "auto" | "manual" | "imported";

type EntityRow = {
  id: string;
  name: string;
  type: EntityType;
  summary: string | null;
  embedding: string | Buffer | null;
  confidence: number;
  source: EntitySource;
  valid_from: number;
  valid_until: number | null;
  created_at: number;
  updated_at: number;
  access_count: number;
  last_accessed_at: number;
  content_hash: string | null;
  namespace: string | null;
};

type EdgeRow = {
  id: string;
  from_id: string;
  to_id: string;
  relation: string;
  weight: number;
  metadata: string | null;
  valid_from: number;
  valid_until: number | null;
  created_at: number;
  namespace: string | null;
};

type EpisodeRow = {
  id: string;
  session_key: string;
  turn_index: number | null;
  content: string;
  extracted_entity_ids: string | null;
  timestamp: number;
  namespace: string | null;
};
```

### Engine Types

```typescript
type EmbedFn = (text: string) => number[];

type Entity = EntityRow & { embeddingVector?: number[] };
type Edge = EdgeRow & { metadataParsed?: Record<string, unknown> };

type GraphSubset = { entities: Entity[]; edges: Edge[] };

type PathStep = {
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  relation: string;
};

type PathResult = { steps: PathStep[]; length: number };

type EntityVersion = { entity: Entity; supersededBy?: string };
```

### Community Types

```typescript
type Community = {
  id: string;
  label: string | null;
  entityCount: number;
  entityIds: string[];
};
```

### Export Types

```typescript
type ExportFormat = "mermaid" | "dot" | "json";
```

### Backup Types

```typescript
type BackupManifest = {
  version: string;
  createdAt: number;
  entityCount: number;
  edgeCount: number;
  episodeCount: number;
  sinceTimestamp?: number;
};

type BackupData = {
  manifest: BackupManifest;
  entities: EntityRow[];
  edges: EdgeRow[];
  episodes: EpisodeRow[];
};
```
