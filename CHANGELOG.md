# Changelog

## [0.5.0] - 2026-04-28

### Added
- **Community detection**: BFS-based connected components algorithm detects entity clusters. Results stored in `communities`/`community_members` tables. `detectCommunities()`, `getCommunities()`, `getCommunityForEntity()` APIs.
- **Multi-hop path finding**: `findPaths(fromId, toId)` discovers all paths between two entities up to configurable depth via BFS with cycle detection. Returns paths sorted by length.
- **Graph visualization export**: `exportGraph()` produces Mermaid, DOT, or JSON output. Supports full-graph and entity-centered (with depth) export. Special characters sanitized for Mermaid/DOT.
- **New agent tools**: `memoryDetectCommunities`, `memoryFindPaths`, `memoryExportGraph`.

## [0.4.0] - 2026-04-28

### Added
- **sqlite-vec ANN index**: Optional approximate nearest neighbor search via `vec0` virtual table. Falls back to current full-scan when sqlite-vec is not installed. Entities auto-synced to vec index on write. Configurable dimensions via `vecDimensions` parameter.
- **Incremental embedding updates**: `embedFn` only called when entity name or summary changes (tracked via `content_hash` column). Saves expensive API calls on no-op updates.
- **Batch operations**: `upsertEntities()` and `addEdges()` for multi-item operations in a single transaction. New `memoryBatchStore` agent tool.
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
