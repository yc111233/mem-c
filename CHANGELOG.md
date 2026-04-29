# Changelog

## [1.0.0] - 2026-04-28

### Added
- **API Reference**: Complete API documentation in `docs/api-reference.md`.
- **Getting Started Guide**: Step-by-step guide in `docs/getting-started.md`.

### Summary
MEM-C v1.0.0 is the first stable release. Key capabilities:
- Temporal knowledge graph with SQLite backend (zero infrastructure)
- Hybrid search: vector + FTS + graph traversal + time decay
- Document import pipeline (markdown, PDF, Feishu, chat history)
- Multi-user namespace isolation
- MCP Server for cross-agent memory sharing
- Event-driven API + REST API
- Backup & restore with incremental and point-in-time support
- Community detection, path finding, visualization export
- Performance benchmarks

## [1.0.0-beta.3] - 2026-04-28

### Added
- **Performance benchmarks**: `npx vitest bench` runs benchmark suite covering entity CRUD, search (FTS/hybrid/cached), graph operations (neighbors, paths, communities), and batch operations at 100/200/1000 entity scales.

## [1.0.0-beta.2] - 2026-04-28

### Added
- **Backup & restore**: `createBackup()` / `createIncrementalBackup()` export graph data as JSON. `restoreBackup()` imports with full restore, point-in-time recovery, and overwrite control. `writeBackup()` / `readBackup()` for file I/O.

## [1.0.0-beta.1] - 2026-04-28

### Added
- **Import progress tracking**: `import_sessions` table tracks import state, chunk progress, and entity counts. `createImportSession()`, `getImportSession()`, `listImportSessions()` APIs. `importDocument()` automatically tracks progress and returns `sessionId`.
- **Resume support**: Import sessions record `last_chunk_index` for future resume capability.

## [0.7.1] - 2026-04-28

### Added
- **PDF parser factory**: `pdfParser(extractText)` — accepts a PDF-to-text callback, splits on page breaks.
- **Feishu document parser factory**: `feishuParser(fetchContent)` — accepts a Feishu API callback, delegates to markdown parser.
- **Batch chat import**: `batchChatImport(engine, sessions, opts)` — import multiple chat sessions in one call.
- `DocumentParser` type is now async-compatible: `(content: string) => DocumentChunk[] | Promise<DocumentChunk[]>`.

## [0.7.0] - 2026-04-28

### Added
- **Document import pipeline**: `importDocument()` — unified API for importing documents into the knowledge graph. Pipeline: parse → smart chunk → LLM extract → merge. Supports pluggable parsers.
- **Smart chunker**: `smartChunk()` — semantic boundary-aware text splitting (paragraph > sentence > hard cut).
- **Markdown parser**: `markdownParser()` — heading-based document chunking.
- **Text parser**: `textParser()` — simple single-chunk parser for plain text.

## [0.6.0] - 2026-04-28

### Added
- **MCP Server**: `createMemoryMcpServer()` / `startMcpServer()` exposes all memory tools via Model Context Protocol. Supports stdio transport. Uses `@modelcontextprotocol/sdk`.
- **Multi-user namespace isolation**: All entities, edges, and episodes support `namespace` column. `MemoryGraphEngine` accepts `namespace` option to scope all queries. Namespace-aware tools.
- **Event-driven API**: `GraphEventEmitter` with typed events for entity/edge lifecycle (`entity:created`, `entity:updated`, `entity:invalidated`, `edge:created`, `edge:updated`, `edge:invalidated`, `communities:detected`).
- **REST API**: `createRestServer()` / `startRestServer()` provides HTTP endpoints for search, store, detail, invalidate, communities, paths, export. Zero external dependencies (Node.js `http`).

## [0.5.1] - 2026-04-28

### Added
- **Community summaries**: `summarizeCommunities()` runs an LLM callback on each detected community to generate labels. Stored in `communities.label`. Prompt template `COMMUNITY_SUMMARY_PROMPT` provided.
- **Relation type inference**: `inferRelationTypes()` analyzes edges with generic relation types (e.g., `relates_to`) and suggests richer alternatives via LLM callback. `applySuggestions()` updates edges with inferred types and metadata.
- **New library tool helpers**: `memorySummarizeCommunities`, `memoryInferRelations` for hosts that can inject LLM callbacks.

## [0.5.0] - 2026-04-28

### Added
- **Community detection**: BFS-based connected components algorithm detects entity clusters. Results stored in `communities`/`community_members` tables. `detectCommunities()`, `getCommunities()`, `getCommunityForEntity()` APIs.
- **Multi-hop path finding**: `findPaths(fromId, toId)` discovers all paths between two entities up to configurable depth via BFS with cycle detection. Returns paths sorted by length.
- **Graph visualization export**: `exportGraph()` produces Mermaid, DOT, or JSON output. Supports full-graph and entity-centered (with depth) export. Special characters sanitized for Mermaid/DOT.
- **New agent tools**: `memoryDetectCommunities`, `memoryFindPaths`, `memoryExportGraph` (now also registered by the OpenClaw plugin).

## [0.4.0] - 2026-04-28

### Added
- **sqlite-vec ANN index**: Optional approximate nearest neighbor search via `vec0` virtual table. Falls back to current full-scan when sqlite-vec is not installed. Entities auto-synced to vec index on write. Configurable dimensions via `vecDimensions` parameter.
- **Incremental embedding updates**: `embedFn` only called when entity name or summary changes (tracked via `content_hash` column). Saves expensive API calls on no-op updates.
- **Batch operations**: `upsertEntities()` and `addEdges()` for multi-item operations in a single transaction. New `memoryBatchStore` agent tool (now also registered by the OpenClaw plugin).
- **FTS score normalization**: Rank-based transform (`-rank / (-rank + 1)`) replaces relative-to-best normalization. Scores are now meaningful (0.1–1.0 range) even with small document sets.
- **Search result cache**: LRU cache (128 entries, 30s TTL) for `searchGraph`. Auto-invalidated on entity writes. Configurable per-query via `cacheTtlMs`. `clearSearchCache()` exported for manual invalidation.

## [0.3.0] - 2026-04-06

### Added
- **Edge deduplication**: `addEdge` now detects existing active edges with same `(from_id, to_id, relation)` and updates weight instead of creating duplicates. New composite index `idx_edges_dedup` for efficient lookups.
- **Binary embedding storage**: Embeddings stored as BLOB (Float32Array) instead of JSON TEXT, ~60% space reduction. Auto-migration converts existing TEXT embeddings on schema init.
- **FTS query safety**: `sanitizeFtsQuery()` strips FTS5 operators before MATCH queries, preventing crashes on special characters like `"`, `*`, `(`, `)`.
- **Embedding hook**: `MemoryGraphEngine` constructor accepts optional `embedFn: (text: string) => number[]` for auto-generating embeddings in `upsertEntity` and `searchGraph`.
- **Entity name normalization**: New `entity_aliases` table with case-insensitive matching. `upsertEntity` falls back to normalized alias lookup. `addAlias()` method for custom aliases.
- **Plugin embedFn integration**: Plugin now wires host-provided `embedFn` into the engine.
- Exported: `sanitizeFtsQuery`, `serializeEmbedding`, `deserializeEmbedding`, `normalizeEntityName`, `EmbedFn`
- Test coverage: 24 new Phase 1 tests, dedicated `graph-tools.test.ts` and `graph-search.test.ts`, shared `test-helpers.ts`

## [0.2.0] - 2026-04-05

### Added
- Entity importance scoring: composite metric (recency + degree + access frequency + confidence)
- Graph consolidation: 3-phase pipeline (merge, decay, prune)
- OpenClaw plugin with lifecycle hooks (auto-recall, auto-extract, pre-compaction)
- Query-aware L0 context injection
- Compaction detection with L0 budget boost
- Access tracking via `touchEntity()`

## [0.1.0] - 2026-04-04

### Added
- Initial release: temporal knowledge graph with SQLite backend
- Hybrid search (vector + FTS5 + graph + time decay)
- Tiered context loading (L0/L1/L2)
- LLM entity/relation extraction
- Markdown memory migration
- Agent tool interfaces (search, store, detail, graph, invalidate)
