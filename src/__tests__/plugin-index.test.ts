import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureGraphSchemaSpy = vi.fn((params: { engine?: { setVecAvailable: (available: boolean) => void } }) => {
  params.engine?.setVecAvailable(true);
  return { entityFtsAvailable: true, vecAvailable: true };
});

const engineInstances: Array<{ setVecAvailable: ReturnType<typeof vi.fn> }> = [];
const registerToolSpy = vi.fn();

vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    constructor(_path: string) {}
  },
}));

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
}));

vi.mock("mem-c", () => ({
  ensureGraphSchema: ensureGraphSchemaSpy,
  MemoryGraphEngine: class {
    setVecAvailable = vi.fn();

    constructor(_db: unknown, _opts?: unknown) {
      engineInstances.push(this);
    }
  },
  memoryGraphSearch: vi.fn(() => ({ formatted: "", results: [] })),
  memoryStore: vi.fn(() => ({ isNew: true, name: "x", edgesCreated: 0 })),
  memoryBatchStore: vi.fn(() => ({ results: [], totalEntities: 0, totalEdges: 0 })),
  memoryDetail: vi.fn(() => ({ found: false, formatted: "" })),
  memoryGraph: vi.fn(() => ({ found: false, formatted: "", entities: [], edges: [] })),
  memoryInvalidate: vi.fn(() => ({ invalidated: false, reason: "missing" })),
  memoryConsolidate: vi.fn(() => ({ merged: 0, decayed: 0, pruned: 0, errors: [] })),
  memoryDetectCommunities: vi.fn(() => ({ communityCount: 0, totalEntities: 0, communities: [] })),
  memoryFindPaths: vi.fn(() => ({ found: false, paths: [], formatted: "" })),
  memoryExportGraph: vi.fn(() => ({ content: "", format: "mermaid", entityCount: 0, edgeCount: 0 })),
  consolidateGraph: vi.fn(() => ({ merged: 0, decayed: 0, pruned: 0, errors: [] })),
  buildL0Context: vi.fn(() => ({ tier: "L0", entries: [], estimatedTokens: 0 })),
  buildQueryAwareL0Context: vi.fn(() => ({ tier: "L0", entries: [], estimatedTokens: 0 })),
  formatL0AsPromptSection: vi.fn(() => ""),
  suggestBudgets: vi.fn(() => ({ l0: 200, l1: 800, l2: 2000 })),
  extractAndMerge: vi.fn(),
}));

function makeMockApi(overrides?: Record<string, unknown>) {
  return {
    config: { dbPath: "/tmp/mem-c-plugin-test.db" },
    registerTool: registerToolSpy,
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerHook: vi.fn(),
    on: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe("memory-graph plugin", () => {
  beforeEach(() => {
    ensureGraphSchemaSpy.mockClear();
    engineInstances.length = 0;
    registerToolSpy.mockClear();
  });

  it("wires vec availability into the engine during initialization", async () => {
    const pluginModule = await import("../../plugin/index.ts");
    const plugin = pluginModule.default;

    plugin.register(makeMockApi());

    expect(ensureGraphSchemaSpy).toHaveBeenCalledTimes(1);
    expect(engineInstances).toHaveLength(1);
  });

  it("registers all JSON-native plugin tools", async () => {
    const pluginModule = await import("../../plugin/index.ts");
    const plugin = pluginModule.default;

    plugin.register(makeMockApi());

    const names = registerToolSpy.mock.calls.map((call) => call[1]?.name);
    expect(names).toEqual([
      "memory_graph_search",
      "memory_graph_store",
      "memory_batch_store",
      "memory_detail",
      "memory_graph",
      "memory_invalidate",
      "memory_consolidate",
      "memory_detect_communities",
      "memory_find_paths",
      "memory_export_graph",
    ]);
  });
});
