// openclaw-memory — Temporal knowledge graph memory for AI agents

// Schema & DDL
export {
  ensureGraphSchema,
  syncEntityFts,
  removeEntityFts,
  searchEntityFts,
  type EntityType,
  type EntitySource,
  type EntityRow,
  type EdgeRow,
  type EpisodeRow,
} from "./host/graph-schema.js";

// Engine (CRUD, traversal, temporal queries)
export {
  MemoryGraphEngine,
  type EntityInput,
  type EdgeInput,
  type EpisodeInput,
  type EntityQuery,
  type EdgeQuery,
  type Entity,
  type Edge,
  type GraphSubset,
  type EntityVersion,
} from "./host/graph-engine.js";

// Hybrid search (vector + FTS + graph)
export {
  searchGraph,
  type GraphSearchOpts,
  type GraphSearchResult,
} from "./host/graph-search.js";

// Tiered context loading (L0/L1/L2)
export {
  buildL0Context,
  buildL1Context,
  buildL2Context,
  formatL0AsPromptSection,
  formatL1AsSearchContext,
  formatL2AsDetail,
  type L0Context,
  type L1Context,
  type L2Context,
} from "./host/graph-context-loader.js";

// Agent tools
export {
  memoryGraphSearch,
  memoryStore,
  memoryDetail,
  memoryGraph,
  memoryInvalidate,
  type MemoryGraphSearchInput,
  type MemoryGraphSearchOutput,
  type MemoryStoreInput,
  type MemoryStoreOutput,
  type MemoryDetailInput,
  type MemoryDetailOutput,
  type MemoryGraphInput,
  type MemoryGraphOutput,
  type MemoryInvalidateInput,
  type MemoryInvalidateOutput,
} from "./host/graph-tools.js";

// Auto-extraction (LLM-driven)
export {
  extractAndMerge,
  buildExtractionUserPrompt,
  EXTRACTION_SYSTEM_PROMPT,
  type ExtractionResult,
  type ExtractedEntity,
  type ExtractedRelation,
  type LlmExtractFn,
  type ExtractAndMergeResult,
} from "./host/graph-extractor.js";

// Migration (markdown → graph)
export {
  migrateMarkdownMemory,
  type MigrationResult,
} from "./host/graph-migrate.js";
