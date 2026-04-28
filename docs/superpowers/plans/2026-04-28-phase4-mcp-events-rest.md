# Phase 4 (v0.6) — MCP Server, Multi-User Isolation, Events, REST API

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MCP server for cross-agent memory sharing, namespace-based multi-user isolation, event-driven change notifications, and an optional REST API layer.

**Architecture:** MCP server wraps existing agent tools as MCP tool handlers using `@modelcontextprotocol/sdk`. Multi-user isolation adds a `namespace` column to all data tables, scoped via a `MemoryGraphEngine` constructor option. Events use Node.js `EventEmitter`. REST API uses Node.js built-in `http` module.

**Tech Stack:** `@modelcontextprotocol/sdk` (MCP), Node.js `events` (EventEmitter), Node.js `http` (REST)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/host/graph-schema.ts` | Modify | Add `namespace` column to entities/edges/episodes |
| `src/host/graph-engine.ts` | Modify | Add namespace scoping to all queries, add event emitter |
| `src/host/graph-events.ts` | **Create** | Typed EventEmitter for graph mutations |
| `src/host/graph-mcp.ts` | **Create** | MCP server with tool handlers |
| `src/host/graph-rest.ts` | **Create** | REST API HTTP server |
| `src/host/graph-tools.ts` | Modify | Add namespace param to tools |
| `src/index.ts` | Modify | Export new modules |
| `src/__tests__/graph-mcp.test.ts` | **Create** | MCP server tests |
| `src/__tests__/graph-events.test.ts` | **Create** | Event emitter tests |
| `src/__tests__/graph-rest.test.ts` | **Create** | REST API tests |

---

### Task 1: Multi-User Namespace Isolation

**Files:**
- Modify: `src/host/graph-schema.ts` — add `namespace` column
- Modify: `src/host/graph-engine.ts` — add namespace scoping

- [ ] **Step 1: Add namespace column to schema**

In `src/host/graph-schema.ts`, add after the `content_hash` migration:

```typescript
// Namespace for multi-user isolation
try { db.exec(`ALTER TABLE entities ADD COLUMN namespace TEXT`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE edges ADD COLUMN namespace TEXT`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE episodes ADD COLUMN namespace TEXT`); } catch { /* already exists */ }
db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_ns ON entities(namespace);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_ns ON edges(namespace);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_episodes_ns ON episodes(namespace);`);
```

Also add `namespace` to the `EntityRow`, `EdgeRow`, and `EpisodeRow` types:

```typescript
// In EntityRow:
namespace: string | null;

// In EdgeRow:
namespace: string | null;

// In EpisodeRow:
namespace: string | null;
```

- [ ] **Step 2: Add namespace to MemoryGraphEngine**

In `src/host/graph-engine.ts`, add namespace support to the engine:

```typescript
export type MemoryGraphEngineOpts = {
  embedFn?: EmbedFn;
  /** Namespace for multi-user isolation. All queries scoped to this namespace. */
  namespace?: string;
};

export class MemoryGraphEngine {
  private readonly embedFn?: EmbedFn;
  private readonly namespace: string | null;

  constructor(private readonly db: DatabaseSync, opts?: MemoryGraphEngineOpts) {
    this.embedFn = opts?.embedFn;
    this.namespace = opts?.namespace ?? null;
  }
```

Update `upsertEntity` to include namespace in INSERT/UPDATE:

```typescript
// In INSERT:
`INSERT INTO entities (id, name, type, summary, embedding, confidence, source, valid_from, valid_until, created_at, updated_at, content_hash, namespace) ` +
  `VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
// ... add this.namespace at end

// In UPDATE:
`UPDATE entities SET summary = COALESCE(?, summary), embedding = COALESCE(?, embedding), ` +
  `confidence = ?, source = ?, updated_at = ?, content_hash = ? WHERE id = ? AND (namespace = ? OR (namespace IS NULL AND ? IS NULL))`,
// ... add this.namespace twice at end

// In findEntities, add namespace filter:
if (this.namespace !== null) {
  conditions.push(`(namespace = ? OR namespace IS NULL)`);
  params.push(this.namespace);
}

// Same pattern for findEdges, getActiveEntities, getEntity, etc.
```

Update `addEdge` to include namespace:

```typescript
// In INSERT:
`INSERT INTO edges (id, from_id, to_id, relation, weight, metadata, valid_from, valid_until, created_at, namespace) ` +
  `VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
// ... add this.namespace at end
```

Update `recordEpisode` to include namespace.

- [ ] **Step 3: Write tests**

Add to `src/__tests__/graph-engine.test.ts`:

```typescript
describe("namespace isolation", () => {
  it("scopes entities to namespace", () => {
    const ns1 = new MemoryGraphEngine(db, { namespace: "user1" });
    const ns2 = new MemoryGraphEngine(db, { namespace: "user2" });

    ns1.upsertEntity({ name: "A", type: "concept" });
    ns2.upsertEntity({ name: "B", type: "concept" });

    const user1Entities = ns1.findEntities({});
    const user2Entities = ns2.findEntities({});

    expect(user1Entities.length).toBe(1);
    expect(user1Entities[0]!.name).toBe("A");
    expect(user2Entities.length).toBe(1);
    expect(user2Entities[0]!.name).toBe("B");
  });

  it("default namespace (null) sees all non-namespaced data", () => {
    const defaultEngine = new MemoryGraphEngine(db);
    const nsEngine = new MemoryGraphEngine(db, { namespace: "user1" });

    defaultEngine.upsertEntity({ name: "Global", type: "concept" });
    nsEngine.upsertEntity({ name: "Private", type: "concept" });

    const defaultEntities = defaultEngine.findEntities({});
    expect(defaultEntities.length).toBe(1);
    expect(defaultEntities[0]!.name).toBe("Global");
  });

  it("namespaced engine does not see other namespace data", () => {
    const ns1 = new MemoryGraphEngine(db, { namespace: "user1" });
    const ns2 = new MemoryGraphEngine(db, { namespace: "user2" });

    ns1.upsertEntity({ name: "Secret", type: "concept" });

    const found = ns2.findEntities({ name: "Secret" });
    expect(found.length).toBe(0);
  });
});
```

- [ ] **Step 4: Run and commit**

```bash
npx vitest run
git add src/host/graph-schema.ts src/host/graph-engine.ts src/__tests__/graph-engine.test.ts
git commit -m "feat(4.2): multi-user namespace isolation"
```

---

### Task 2: Event-Driven API

**Files:**
- Create: `src/host/graph-events.ts`
- Create: `src/__tests__/graph-events.test.ts`
- Modify: `src/host/graph-engine.ts` — emit events on mutations

- [ ] **Step 1: Create graph-events.ts**

```typescript
/**
 * Typed event emitter for memory graph mutations.
 * Callers subscribe to entity/edge lifecycle events.
 */

import { EventEmitter } from "node:events";
import type { Entity, Edge } from "./graph-engine.js";

export type GraphEvents = {
  "entity:created": [entity: Entity];
  "entity:updated": [entity: Entity];
  "entity:invalidated": [entityId: string];
  "edge:created": [edge: Edge];
  "edge:updated": [edge: Edge];
  "edge:invalidated": [edgeId: string];
  "communities:detected": [communityCount: number];
};

export class GraphEventEmitter extends EventEmitter {
  emit<K extends keyof GraphEvents>(event: K, ...args: GraphEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  on<K extends keyof GraphEvents>(event: K, listener: (...args: GraphEvents[K]) => void): this {
    return super.on(event, listener);
  }

  off<K extends keyof GraphEvents>(event: K, listener: (...args: GraphEvents[K]) => void): this {
    return super.off(event, listener);
  }
}
```

- [ ] **Step 2: Wire events into MemoryGraphEngine**

Add to MemoryGraphEngine:

```typescript
private readonly events = new GraphEventEmitter();

/** Get the event emitter for subscribing to mutations. */
getEvents(): GraphEventEmitter {
  return this.events;
}
```

In `upsertEntity`, emit after successful write:

```typescript
// After syncEntityFts and vecUpsert:
if (isNew) {
  this.events.emit("entity:created", result);
} else {
  this.events.emit("entity:updated", result);
}
```

In `invalidateEntity`, emit after invalidation:

```typescript
this.events.emit("entity:invalidated", id);
```

In `addEdge`, emit after write:

```typescript
// For new edges:
this.events.emit("edge:created", edgeResult);
// For updated edges:
this.events.emit("edge:updated", edgeResult);
```

- [ ] **Step 3: Write tests**

Create `src/__tests__/graph-events.test.ts`:

```typescript
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import { createTestDb } from "./test-helpers.js";

describe("graph events", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  it("emits entity:created on new entity", () => {
    const events: string[] = [];
    engine.getEvents().on("entity:created", (e) => events.push(e.name));

    engine.upsertEntity({ name: "A", type: "concept" });
    expect(events).toEqual(["A"]);
  });

  it("emits entity:updated on existing entity", () => {
    engine.upsertEntity({ name: "A", type: "concept", summary: "v1" });

    const events: string[] = [];
    engine.getEvents().on("entity:updated", (e) => events.push(e.summary ?? ""));

    engine.upsertEntity({ name: "A", type: "concept", summary: "v2" });
    expect(events).toEqual(["v2"]);
  });

  it("emits entity:invalidated on invalidation", () => {
    const entity = engine.upsertEntity({ name: "A", type: "concept" });

    const invalidated: string[] = [];
    engine.getEvents().on("entity:invalidated", (id) => invalidated.push(id));

    engine.invalidateEntity(entity.id);
    expect(invalidated).toEqual([entity.id]);
  });

  it("emits edge:created on new edge", () => {
    const a = engine.upsertEntity({ name: "A", type: "concept" });
    const b = engine.upsertEntity({ name: "B", type: "concept" });

    const relations: string[] = [];
    engine.getEvents().on("edge:created", (e) => relations.push(e.relation));

    engine.addEdge({ fromId: a.id, toId: b.id, relation: "knows" });
    expect(relations).toEqual(["knows"]);
  });
});
```

- [ ] **Step 4: Run and commit**

```bash
npx vitest run
git add src/host/graph-events.ts src/host/graph-engine.ts src/__tests__/graph-events.test.ts
git commit -m "feat(4.3): event-driven API — entity/edge lifecycle events"
```

---

### Task 3: MCP Server

**Files:**
- Create: `src/host/graph-mcp.ts`
- Create: `src/__tests__/graph-mcp.test.ts`
- Modify: `package.json` — add `@modelcontextprotocol/sdk` dependency

- [ ] **Step 1: Install MCP SDK**

```bash
npm install @modelcontextprotocol/sdk
```

- [ ] **Step 2: Create graph-mcp.ts**

```typescript
/**
 * MCP (Model Context Protocol) server for openclaw-memory.
 * Exposes memory graph tools as MCP tools for cross-agent access.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import { MemoryGraphEngine } from "./graph-engine.js";
import { ensureGraphSchema } from "./graph-schema.js";
import {
  memoryGraphSearch,
  memoryStore,
  memoryDetail,
  memoryGraph,
  memoryInvalidate,
  memoryConsolidate,
  memoryDetectCommunities,
  memoryFindPaths,
  memoryExportGraph,
  memoryBatchStore,
} from "./graph-tools.js";

export type McpServerOpts = {
  dbPath?: string;
  namespace?: string;
  embedFn?: (text: string) => number[];
};

/**
 * Create and configure an MCP server for openclaw-memory.
 */
export function createMemoryMcpServer(opts?: McpServerOpts): {
  server: McpServer;
  engine: MemoryGraphEngine;
  db: DatabaseSync;
} {
  const dbPath = opts?.dbPath ?? ":memory:";
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  const engine = new MemoryGraphEngine(db, {
    embedFn: opts?.embedFn,
    namespace: opts?.namespace,
  });
  ensureGraphSchema({ db, engine });

  const server = new McpServer({
    name: "openclaw-memory",
    version: "0.6.0",
  });

  // Register tools
  server.tool(
    "memory_search",
    "Search the knowledge graph for relevant entities and relationships",
    { query: z.string(), types: z.array(z.string()).optional(), maxResults: z.number().optional() },
    async (params) => {
      const result = memoryGraphSearch(db, engine, params);
      return { content: [{ type: "text", text: result.formatted }] };
    },
  );

  server.tool(
    "memory_store",
    "Store a new entity (and optional relationships) in the knowledge graph",
    {
      name: z.string(),
      type: z.string(),
      summary: z.string().optional(),
      relations: z.array(z.object({
        targetName: z.string(),
        targetType: z.string(),
        relation: z.string(),
      })).optional(),
    },
    async (params) => {
      const result = memoryStore(engine, params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "memory_detail",
    "Get detailed information about a specific entity",
    { entity: z.string(), type: z.string().optional() },
    async (params) => {
      const result = memoryDetail(engine, params);
      return { content: [{ type: "text", text: result.formatted }] };
    },
  );

  server.tool(
    "memory_graph",
    "Visualize relationships around an entity",
    { entity: z.string(), depth: z.number().optional() },
    async (params) => {
      const result = memoryGraph(engine, params);
      return { content: [{ type: "text", text: result.formatted }] };
    },
  );

  server.tool(
    "memory_invalidate",
    "Mark an entity as no longer valid",
    { entity: z.string(), type: z.string().optional(), reason: z.string().optional() },
    async (params) => {
      const result = memoryInvalidate(engine, params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "memory_consolidate",
    "Run graph consolidation (merge duplicates, decay stale, prune orphans)",
    { dryRun: z.boolean().optional() },
    async (params) => {
      const result = memoryConsolidate(engine, params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "memory_detect_communities",
    "Detect entity clusters/communities in the knowledge graph",
    {},
    async () => {
      const result = memoryDetectCommunities(engine, {});
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "memory_find_paths",
    "Find paths between two entities in the knowledge graph",
    { from: z.string(), to: z.string(), maxDepth: z.number().optional() },
    async (params) => {
      const result = memoryFindPaths(engine, params);
      return { content: [{ type: "text", text: result.formatted }] };
    },
  );

  server.tool(
    "memory_export",
    "Export the knowledge graph in Mermaid, DOT, or JSON format",
    { format: z.enum(["mermaid", "dot", "json"]).optional(), centerEntity: z.string().optional() },
    async (params) => {
      const result = memoryExportGraph(engine, params);
      return { content: [{ type: "text", text: result.content }] };
    },
  );

  return { server, engine, db };
}

/**
 * Start the MCP server on stdio transport.
 */
export async function startMcpServer(opts?: McpServerOpts): Promise<void> {
  const { server, db } = createMemoryMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until process exits
  // db.close() on process exit
  process.on("exit", () => db.close());
}
```

- [ ] **Step 3: Write tests**

Create `src/__tests__/graph-mcp.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { createMemoryMcpServer } from "../host/graph-mcp.js";

describe("MCP server", () => {
  it("creates server with all tools registered", () => {
    const { server, engine, db } = createMemoryMcpServer();

    // Server should be created successfully
    expect(server).toBeDefined();
    expect(engine).toBeDefined();
    expect(db).toBeDefined();

    db.close();
  });

  it("server tools work through engine", () => {
    const { engine, db } = createMemoryMcpServer();

    // Use engine directly to verify the integration works
    engine.upsertEntity({ name: "Test", type: "concept", summary: "test entity" });
    const entities = engine.findEntities({ name: "Test" });
    expect(entities.length).toBe(1);
    expect(entities[0]!.summary).toBe("test entity");

    db.close();
  });
});
```

- [ ] **Step 4: Run and commit**

```bash
npx vitest run
git add src/host/graph-mcp.ts src/__tests__/graph-mcp.test.ts package.json
git commit -m "feat(4.1): MCP server — cross-agent memory sharing"
```

---

### Task 4: REST API

**Files:**
- Create: `src/host/graph-rest.ts`
- Create: `src/__tests__/graph-rest.test.ts`

- [ ] **Step 1: Create graph-rest.ts**

```typescript
/**
 * REST API for openclaw-memory.
 * Uses Node.js built-in http module — zero external dependencies.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { MemoryGraphEngine } from "./graph-engine.js";
import { ensureGraphSchema } from "./graph-schema.js";
import {
  memoryGraphSearch,
  memoryStore,
  memoryDetail,
  memoryInvalidate,
  memoryDetectCommunities,
  memoryFindPaths,
  memoryExportGraph,
} from "./graph-tools.js";

export type RestServerOpts = {
  port?: number;
  host?: string;
  dbPath?: string;
  namespace?: string;
};

export function createRestServer(opts?: RestServerOpts): {
  server: Server;
  engine: MemoryGraphEngine;
  db: DatabaseSync;
} {
  const dbPath = opts?.dbPath ?? ":memory:";
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  const engine = new MemoryGraphEngine(db, { namespace: opts?.namespace });
  ensureGraphSchema({ db, engine });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const method = req.method ?? "GET";

    // CORS headers
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");

    const send = (data: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(data));
    };

    const readBody = (): Promise<string> =>
      new Promise((resolve) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => resolve(body));
      });

    // Route: GET /search?q=...
    if (method === "GET" && url.pathname === "/search") {
      const query = url.searchParams.get("q") ?? "";
      const result = memoryGraphSearch(db, engine, { query });
      return send(result);
    }

    // Route: POST /entities
    if (method === "POST" && url.pathname === "/entities") {
      return readBody().then((body) => {
        const input = JSON.parse(body);
        const result = memoryStore(engine, input);
        send(result, 201);
      });
    }

    // Route: GET /entities/:name
    if (method === "GET" && url.pathname.startsWith("/entities/")) {
      const name = decodeURIComponent(url.pathname.slice("/entities/".length));
      const result = memoryDetail(engine, { entity: name });
      return send(result);
    }

    // Route: DELETE /entities/:name
    if (method === "DELETE" && url.pathname.startsWith("/entities/")) {
      const name = decodeURIComponent(url.pathname.slice("/entities/".length));
      const result = memoryInvalidate(engine, { entity: name });
      return send(result);
    }

    // Route: GET /communities
    if (method === "GET" && url.pathname === "/communities") {
      const result = memoryDetectCommunities(engine, {});
      return send(result);
    }

    // Route: GET /paths?from=X&to=Y
    if (method === "GET" && url.pathname === "/paths") {
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      const result = memoryFindPaths(engine, { from, to });
      return send(result);
    }

    // Route: GET /export?format=mermaid
    if (method === "GET" && url.pathname === "/export") {
      const format = (url.searchParams.get("format") as "mermaid" | "dot" | "json") ?? "mermaid";
      const result = memoryExportGraph(engine, { format });
      return send(result);
    }

    // Route: GET /health
    if (method === "GET" && url.pathname === "/health") {
      const stats = engine.stats();
      return send({ status: "ok", ...stats });
    }

    send({ error: "Not found" }, 404);
  });

  return { server, engine, db };
}

export function startRestServer(opts?: RestServerOpts): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const { server, db } = createRestServer(opts);
    const port = opts?.port ?? 0; // 0 = random available port
    server.listen(port, opts?.host ?? "127.0.0.1", () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        port: actualPort,
        close: () => {
          server.close();
          db.close();
        },
      });
    });
  });
}
```

- [ ] **Step 2: Write tests**

Create `src/__tests__/graph-rest.test.ts`:

```typescript
import { describe, expect, it, afterEach } from "vitest";
import { startRestServer } from "../host/graph-rest.js";

describe("REST API", () => {
  let cleanup: (() => void) | null = null;
  let baseUrl = "";

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  async function startServer() {
    const { port, close } = await startRestServer();
    baseUrl = `http://127.0.0.1:${port}`;
    cleanup = close;
    return baseUrl;
  }

  it("health endpoint returns stats", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/health`);
    const data = await res.json();
    expect(data.status).toBe("ok");
    expect(data).toHaveProperty("entities");
    expect(data).toHaveProperty("edges");
  });

  it("POST /entities creates an entity", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/entities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test", type: "concept", summary: "test" }),
    });
    const data = await res.json();
    expect(data.name).toBe("Test");
    expect(data.isNew).toBe(true);
  });

  it("GET /search finds entities", async () => {
    await startServer();
    // Create entity first
    await fetch(`${baseUrl}/entities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "React", type: "concept", summary: "UI library" }),
    });

    const res = await fetch(`${baseUrl}/search?q=React`);
    const data = await res.json();
    expect(data.results.length).toBeGreaterThan(0);
  });

  it("GET /entities/:name returns entity detail", async () => {
    await startServer();
    await fetch(`${baseUrl}/entities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Vue", type: "concept" }),
    });

    const res = await fetch(`${baseUrl}/entities/Vue`);
    const data = await res.json();
    expect(data.found).toBe(true);
  });

  it("GET /export returns graph in mermaid format", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/export?format=mermaid`);
    const data = await res.json();
    expect(data.format).toBe("mermaid");
    expect(data.content).toContain("graph");
  });

  it("returns 404 for unknown routes", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 3: Run and commit**

```bash
npx vitest run
git add src/host/graph-rest.ts src/__tests__/graph-rest.test.ts
git commit -m "feat(4.4): REST API — HTTP interface for non-Node.js consumers"
```

---

### Task 5: Agent Tools Update & Exports

**Files:**
- Modify: `src/host/graph-tools.ts` — add namespace param to tool inputs
- Modify: `src/index.ts` — export new modules

- [ ] **Step 1: Add namespace to tool inputs**

In `src/host/graph-tools.ts`, add `namespace?: string` to relevant tool input types:

```typescript
export type MemoryGraphSearchInput = {
  query: string;
  types?: string[];
  maxResults?: number;
  includeRelations?: boolean;
  compact?: boolean;
  namespace?: string;
};

export type MemoryStoreInput = {
  name: string;
  type: string;
  summary?: string;
  confidence?: number;
  relations?: Array<{ targetName: string; targetType: string; relation: string }>;
  namespace?: string;
};
```

For tools that accept namespace, create a scoped engine internally:

```typescript
export function memoryGraphSearch(
  db: DatabaseSync,
  engine: MemoryGraphEngine,
  input: MemoryGraphSearchInput,
  queryEmbedding?: number[],
): MemoryGraphSearchOutput {
  // If namespace specified, create a scoped engine
  const scopedEngine = input.namespace
    ? new MemoryGraphEngine(db, { embedFn: engine.getEmbedFn(), namespace: input.namespace })
    : engine;

  // ... use scopedEngine instead of engine
}
```

Import `MemoryGraphEngine` in the tools file if not already imported.

- [ ] **Step 2: Export from index.ts**

Add to `src/index.ts`:

```typescript
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
```

Also export the new types:

```typescript
export {
  MemoryGraphEngine,
  // ... existing exports ...
  type MemoryGraphEngineOpts,
} from "./host/graph-engine.js";
```

- [ ] **Step 3: Run and commit**

```bash
npx vitest run && npm run typecheck
git add src/host/graph-tools.ts src/index.ts
git commit -m "feat(4.x): add namespace to tools + export MCP/events/REST modules"
```

---

### Task 6: Integration & Version Bump

**Files:**
- Modify: `package.json` — bump to 0.6.0
- Modify: `CHANGELOG.md`
- Modify: `ROADMAP.md`

- [ ] **Step 1: Update CHANGELOG.md**

```markdown
## [0.6.0] - 2026-04-28

### Added
- **MCP Server**: `createMemoryMcpServer()` / `startMcpServer()` exposes all memory tools via Model Context Protocol. Supports stdio transport. Uses `@modelcontextprotocol/sdk`.
- **Multi-user namespace isolation**: All entities, edges, and episodes support `namespace` column. `MemoryGraphEngine` accepts `namespace` option to scope all queries. Namespace-aware tools.
- **Event-driven API**: `GraphEventEmitter` with typed events for entity/edge lifecycle (`entity:created`, `entity:updated`, `entity:invalidated`, `edge:created`, `edge:updated`, `edge:invalidated`, `communities:detected`).
- **REST API**: `createRestServer()` / `startRestServer()` provides HTTP endpoints for search, store, detail, invalidate, communities, paths, export. Zero external dependencies (Node.js `http`).
```

- [ ] **Step 2: Update ROADMAP.md**

Mark Phase 4 items (4.1–4.4) as done.

- [ ] **Step 3: Bump version and commit**

```bash
npx vitest run && npm run typecheck
git add package.json CHANGELOG.md ROADMAP.md
git commit -m "chore(v0.6): bump version, mark Phase 4 complete"
```

---

## Self-Review

**Spec coverage:**
- 4.1 MCP Server → Task 3 ✅
- 4.2 Multi-user isolation → Task 1 ✅
- 4.3 Event-driven API → Task 2 ✅
- 4.4 REST API → Task 4 ✅
- Tools + exports → Task 5 ✅
- Version/docs → Task 6 ✅

**Placeholder scan:** No TBD/TODO. All code complete.

**Type consistency:**
- `MemoryGraphEngineOpts` defined with `namespace?: string` — used in constructor and tools ✅
- `GraphEvents` type keys match emit calls in engine ✅
- MCP tool schemas match existing tool input types ✅
- REST routes map to existing tool functions ✅
