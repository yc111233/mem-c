// openclaw-memory — Temporal knowledge graph memory for AI agents

// Schema & DDL
export {
  ensureGraphSchema,
  syncEntityFts,
  removeEntityFts,
  searchEntityFts,
  sanitizeFtsQuery,
  type EntityType,
  type EntitySource,
  type EntityRow,
  type EdgeRow,
  type EpisodeRow,
} from "./host/graph-schema.js";

// Engine (CRUD, traversal, temporal queries)
export {
  MemoryGraphEngine,
  computeImportance,
  serializeEmbedding,
  deserializeEmbedding,
  normalizeEntityName,
  type EmbedFn,
  type EntityInput,
  type EdgeInput,
  type EpisodeInput,
  type EntityQuery,
  type EdgeQuery,
  type Entity,
  type Edge,
  type GraphSubset,
  type PathStep,
  type PathResult,
  type FindPathsOpts,
  type EntityVersion,
  type MemoryGraphEngineOpts,
} from "./host/graph-engine.js";

// Hybrid search (vector + FTS + graph)
export {
  searchGraph,
  clearSearchCache,
  type GraphSearchOpts,
  type GraphSearchResult,
} from "./host/graph-search.js";

// Tiered context loading (L0/L1/L2) + adaptive budget
export {
  buildL0Context,
  buildQueryAwareL0Context,
  buildL1Context,
  buildL2Context,
  suggestBudgets,
  formatL0AsPromptSection,
  formatL1AsSearchContext,
  formatL2AsDetail,
  type ContextBudget,
  type L0Context,
  type L1Context,
  type L2Context,
  type L2DetailLevel,
} from "./host/graph-context-loader.js";

// Agent tools
export {
  memoryGraphSearch,
  memoryStore,
  memoryBatchStore,
  memoryDetail,
  memoryGraph,
  memoryInvalidate,
  memoryConsolidate,
  memoryDetectCommunities,
  memoryFindPaths,
  memoryExportGraph,
  memorySummarizeCommunities,
  memoryInferRelations,
  type MemoryGraphSearchInput,
  type MemoryGraphSearchOutput,
  type MemoryStoreInput,
  type MemoryStoreOutput,
  type MemoryBatchStoreInput,
  type MemoryBatchStoreOutput,
  type MemoryDetailInput,
  type MemoryDetailOutput,
  type MemoryGraphInput,
  type MemoryGraphOutput,
  type MemoryInvalidateInput,
  type MemoryInvalidateOutput,
  type MemoryConsolidateInput,
  type MemoryConsolidateOutput,
  type MemoryDetectCommunitiesInput,
  type MemoryDetectCommunitiesOutput,
  type MemoryFindPathsInput,
  type MemoryFindPathsOutput,
  type MemoryExportGraphInput,
  type MemoryExportGraphOutput,
  type MemorySummarizeCommunitiesInput,
  type MemorySummarizeCommunitiesOutput,
  type MemoryInferRelationsInput,
  type MemoryInferRelationsOutput,
} from "./host/graph-tools.js";

// Community detection
export {
  detectCommunities,
  getCommunities,
  getCommunityForEntity,
  type Community,
  type DetectionResult,
  type DetectionOpts,
  type SummarizeFn,
  COMMUNITY_SUMMARY_PROMPT,
} from "./host/graph-community.js";

// Relation inference
export {
  inferRelationTypes,
  type InferRelationFn,
  type InferenceSuggestion,
  type InferenceResult,
  type InferenceOpts,
} from "./host/graph-inference.js";

// Graph export (Mermaid / DOT / JSON)
export {
  exportGraph,
  type ExportFormat,
  type ExportOpts as GraphExportOpts,
  type ExportResult as GraphExportResult,
} from "./host/graph-export.js";

// Graph consolidation
export {
  consolidateGraph,
  type ConsolidationResult,
  type ConsolidationOpts,
} from "./host/graph-consolidator.js";

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

// Document import pipeline
export {
  importDocument,
  smartChunk,
  batchChatImport,
  type DocumentChunk,
  type DocumentParser,
  type ImportOpts,
  type ImportResult,
  type ChatMessage,
  type BatchImportOpts,
  type BatchImportResult,
} from "./host/graph-import.js";

// Document parsers
export {
  markdownParser,
  textParser,
  pdfParser,
  feishuParser,
} from "./host/graph-parsers.js";

// sqlite-vec ANN index
export {
  ensureVecIndex,
  vecUpsert,
  vecRemove,
  vecKnn,
  vecSyncAll,
} from "./host/graph-vec.js";

// Event system
export {
  GraphEventEmitter,
  type GraphEvents,
} from "./host/graph-events.js";

// MCP server
export {
  createMemoryMcpServer,
  startMcpServer,
  type McpServerOpts,
} from "./host/graph-mcp.js";

// REST API
export {
  createRestServer,
  startRestServer,
  type RestServerOpts,
} from "./host/graph-rest.js";
