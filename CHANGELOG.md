# Changelog

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
