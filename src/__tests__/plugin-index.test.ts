import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureGraphSchemaSpy = vi.fn((params: { engine?: { setVecAvailable: (available: boolean) => void } }) => {
  params.engine?.setVecAvailable(true);
  return { entityFtsAvailable: true, vecAvailable: true };
});

const engineInstances: Array<{ setVecAvailable: ReturnType<typeof vi.fn> }> = [];

vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    constructor(_path: string) {}
  },
}));

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
}));

vi.mock("openclaw-memory", () => ({
  ensureGraphSchema: ensureGraphSchemaSpy,
  MemoryGraphEngine: class {
    setVecAvailable = vi.fn();

    constructor(_db: unknown, _opts?: unknown) {
      engineInstances.push(this);
    }
  },
  memoryGraphSearch: vi.fn(() => ({ formatted: "", results: [] })),
  memoryStore: vi.fn(() => ({ isNew: true, name: "x", edgesCreated: 0 })),
  memoryDetail: vi.fn(() => ({ found: false, formatted: "" })),
  memoryGraph: vi.fn(() => ({ found: false, formatted: "", entities: [], edges: [] })),
  memoryInvalidate: vi.fn(() => ({ invalidated: false, reason: "missing" })),
  memoryConsolidate: vi.fn(() => ({ merged: 0, decayed: 0, pruned: 0, errors: [] })),
  consolidateGraph: vi.fn(() => ({ merged: 0, decayed: 0, pruned: 0, errors: [] })),
  buildL0Context: vi.fn(() => ({ tier: "L0", entries: [], estimatedTokens: 0 })),
  buildQueryAwareL0Context: vi.fn(() => ({ tier: "L0", entries: [], estimatedTokens: 0 })),
  formatL0AsPromptSection: vi.fn(() => ""),
  suggestBudgets: vi.fn(() => ({ l0: 200, l1: 800, l2: 2000 })),
  extractAndMerge: vi.fn(),
}));

// TODO: rewrite for current plugin API (register expects api object, not pluginConfig)
describe.skip("memory-graph plugin", () => {
  beforeEach(() => {
    ensureGraphSchemaSpy.mockClear();
    engineInstances.length = 0;
  });

  it("wires vec availability into the engine during initialization", async () => {
    const pluginModule = await import("../../plugin/index.ts");
    const plugin = pluginModule.default;

    plugin.register({
      pluginConfig: { dbPath: "/tmp/openclaw-memory-plugin-test.db" },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerTool: vi.fn(),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      on: vi.fn(),
    });

    expect(ensureGraphSchemaSpy).toHaveBeenCalledTimes(1);
    expect(engineInstances).toHaveLength(1);
    expect(engineInstances[0]!.setVecAvailable).toHaveBeenCalledWith(true);
  });
});
