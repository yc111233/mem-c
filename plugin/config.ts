import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

export type MemoryGraphConfig = {
  dbPath: string;
  autoExtract: boolean;
  autoRecall: boolean;
  recallMaxTokens: number;
  recallMaxEntities: number;
  searchMaxResults: number;
  /** Total token budget available from the host. When set, L0/L1/L2 budgets are derived from this. */
  recallAvailableBudget: number;
};

const DEFAULT_DB_PATH = join(homedir(), ".mem-c", "graph.db");
const DEFAULT_RECALL_MAX_TOKENS = 200;
const DEFAULT_RECALL_MAX_ENTITIES = 50;
const DEFAULT_SEARCH_MAX_RESULTS = 6;

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export const memoryGraphConfigSchema = {
  parse(value: unknown): MemoryGraphConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      value = {};
    }
    const cfg = value as Record<string, unknown>;

    const rawDbPath =
      typeof cfg.dbPath === "string" && cfg.dbPath.trim()
        ? cfg.dbPath.trim()
        : DEFAULT_DB_PATH;
    const dbPath = resolvePath(rawDbPath.replace(/^~/, homedir()));

    return {
      dbPath,
      autoExtract: cfg.autoExtract !== false,
      autoRecall: cfg.autoRecall !== false,
      recallMaxTokens: Math.max(
        50,
        Math.floor(toNumber(cfg.recallMaxTokens, DEFAULT_RECALL_MAX_TOKENS)),
      ),
      recallMaxEntities: Math.max(
        5,
        Math.floor(toNumber(cfg.recallMaxEntities, DEFAULT_RECALL_MAX_ENTITIES)),
      ),
      searchMaxResults: Math.max(
        1,
        Math.floor(toNumber(cfg.searchMaxResults, DEFAULT_SEARCH_MAX_RESULTS)),
      ),
      recallAvailableBudget: Math.max(
        0,
        Math.floor(toNumber(cfg.recallAvailableBudget, 0)),
      ),
    };
  },
};
