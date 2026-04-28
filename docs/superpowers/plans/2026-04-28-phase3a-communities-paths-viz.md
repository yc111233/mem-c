# Phase 3a (v0.5) — Community Detection, Multi-Hop Reasoning, Visualization Export

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add graph community detection (connected components), multi-hop path finding between entities, and Mermaid/DOT/JSON graph export — all pure algorithmic, zero LLM dependencies.

**Architecture:** Community detection uses BFS-based connected components over the active edge graph, storing results in a `communities` table. Multi-hop reasoning uses BFS with path tracking to find all paths between two entities up to a configurable depth. Visualization export is a pure formatting function that takes a `GraphSubset` and produces Mermaid, DOT, or JSON.

**Tech Stack:** Pure TypeScript + SQLite (no new dependencies)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/host/graph-schema.ts` | Modify | Add `communities` and `community_members` tables |
| `src/host/graph-community.ts` | **Create** | Connected components algorithm + community CRUD |
| `src/host/graph-engine.ts` | Modify | Add `findPaths`, `getCommunity` methods |
| `src/host/graph-export.ts` | **Create** | Mermaid/DOT/JSON visualization export |
| `src/host/graph-tools.ts` | Modify | Add `memoryDetectCommunities`, `memoryFindPaths`, `memoryExportGraph` tools |
| `src/index.ts` | Modify | Export new modules |
| `src/__tests__/graph-community.test.ts` | **Create** | Community detection tests |
| `src/__tests__/graph-paths.test.ts` | **Create** | Multi-hop path tests |
| `src/__tests__/graph-export.test.ts` | **Create** | Export format tests |

---

### Task 1: Schema — Communities Tables

**Files:**
- Modify: `src/host/graph-schema.ts:162-168` (after meta table, before FTS block)

- [ ] **Step 1: Add communities and community_members tables**

In `src/host/graph-schema.ts`, after the `meta` table creation (after line ~168), add:

```typescript
// -- communities -----------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS communities (
    id TEXT PRIMARY KEY,
    label TEXT,
    entity_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_communities_updated ON communities(updated_at);`);

// -- community_members -----------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS community_members (
    community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    PRIMARY KEY (community_id, entity_id)
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_cm_entity ON community_members(entity_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_cm_community ON community_members(community_id);`);
```

- [ ] **Step 2: Run existing tests to verify no breakage**

Run: `npx vitest run`
Expected: All 150 tests PASS (schema changes are additive, CREATE IF NOT EXISTS).

- [ ] **Step 3: Commit**

```bash
git add src/host/graph-schema.ts
git commit -m "feat(3.1): add communities and community_members tables to schema"
```

---

### Task 2: Connected Components Algorithm

**Files:**
- Create: `src/host/graph-community.ts`
- Create: `src/__tests__/graph-community.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/graph-community.test.ts`:

```typescript
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import { detectCommunities, getCommunities, getCommunityForEntity, type Community } from "../host/graph-community.js";
import { createTestDb } from "./test-helpers.js";

describe("community detection", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  describe("detectCommunities", () => {
    it("finds a single connected component", () => {
      // A-B-C all connected
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      const c = engine.upsertEntity({ name: "C", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });
      engine.addEdge({ fromId: b.id, toId: c.id, relation: "relates" });

      const result = detectCommunities(engine);

      expect(result.communities.length).toBe(1);
      expect(result.communities[0]!.entityCount).toBe(3);
      expect(result.totalEntities).toBe(3);
    });

    it("finds multiple disconnected components", () => {
      // Component 1: A-B
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

      // Component 2: C-D
      const c = engine.upsertEntity({ name: "C", type: "concept" });
      const d = engine.upsertEntity({ name: "D", type: "concept" });
      engine.addEdge({ fromId: c.id, toId: d.id, relation: "relates" });

      // Isolated: E
      engine.upsertEntity({ name: "E", type: "concept" });

      const result = detectCommunities(engine);

      expect(result.communities.length).toBe(3);
      // Each component has 2, 2, 1 entities
      const sizes = result.communities.map((c) => c.entityCount).sort();
      expect(sizes).toEqual([1, 2, 2]);
    });

    it("handles empty graph", () => {
      const result = detectCommunities(engine);
      expect(result.communities.length).toBe(0);
      expect(result.totalEntities).toBe(0);
    });

    it("respects activeOnly flag", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

      engine.invalidateEntity(a.id);

      const result = detectCommunities(engine, { activeOnly: true });
      // Only B is active, and it's isolated
      expect(result.communities.length).toBe(1);
      expect(result.communities[0]!.entityCount).toBe(1);
    });

    it("stores results in database", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

      detectCommunities(engine);

      const stored = getCommunities(engine);
      expect(stored.length).toBe(1);
      expect(stored[0]!.entityCount).toBe(2);
    });

    it("clears old communities on re-detect", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

      detectCommunities(engine);
      detectCommunities(engine); // re-run

      const stored = getCommunities(engine);
      expect(stored.length).toBe(1); // not 2
    });
  });

  describe("getCommunityForEntity", () => {
    it("returns community for a given entity", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

      detectCommunities(engine);

      const community = getCommunityForEntity(engine, a.id);
      expect(community).not.toBeNull();
      expect(community!.entityCount).toBe(2);
    });

    it("returns null for entity not in any community", () => {
      const community = getCommunityForEntity(engine, "nonexistent");
      expect(community).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/graph-community.test.ts`
Expected: FAIL — `graph-community.js` does not exist.

- [ ] **Step 3: Implement graph-community.ts**

Create `src/host/graph-community.ts`:

```typescript
/**
 * Community detection using BFS-based connected components.
 * Finds connected subgraphs in the active entity/edge graph.
 */

import type { DatabaseSync } from "node:sqlite";
import type { MemoryGraphEngine, Entity } from "./graph-engine.js";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Community = {
  id: string;
  label: string | null;
  entityCount: number;
  entityIds: string[];
};

export type DetectionResult = {
  communities: Community[];
  totalEntities: number;
};

export type DetectionOpts = {
  /** Only consider active entities. Default true. */
  activeOnly?: boolean;
  /** Max community size to track. Larger communities are split or skipped. Default 1000. */
  maxCommunitySize?: number;
};

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect communities in the graph using BFS connected components.
 * Clears previous community data and stores fresh results.
 */
export function detectCommunities(
  engine: MemoryGraphEngine,
  opts?: DetectionOpts,
): DetectionResult {
  const activeOnly = opts?.activeOnly ?? true;
  const maxCommunitySize = opts?.maxCommunitySize ?? 1000;
  const db = engine.getDb();

  // Build adjacency list from active edges
  const adjacency = new Map<string, Set<string>>();
  const entityMap = new Map<string, Entity>();

  // Load entities
  const entities = activeOnly
    ? engine.getActiveEntities()
    : engine.findEntities({ activeOnly: false, limit: 10_000 });

  for (const e of entities) {
    adjacency.set(e.id, new Set());
    entityMap.set(e.id, e);
  }

  // Load edges
  const edgeRows = db
    .prepare(`SELECT from_id, to_id FROM edges WHERE valid_until IS NULL`)
    .all() as Array<{ from_id: string; to_id: string }>;

  for (const edge of edgeRows) {
    if (adjacency.has(edge.from_id) && adjacency.has(edge.to_id)) {
      adjacency.get(edge.from_id)!.add(edge.to_id);
      adjacency.get(edge.to_id)!.add(edge.from_id);
    }
  }

  // BFS connected components
  const visited = new Set<string>();
  const communities: Community[] = [];

  for (const entityId of adjacency.keys()) {
    if (visited.has(entityId)) continue;

    // BFS from this entity
    const component: string[] = [];
    const queue = [entityId];
    visited.add(entityId);

    while (queue.length > 0 && component.length < maxCommunitySize) {
      const current = queue.shift()!;
      component.push(current);

      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    if (component.length > 0) {
      communities.push({
        id: randomUUID(),
        label: null, // could be LLM-generated later (Phase 3b)
        entityCount: component.length,
        entityIds: component,
      });
    }
  }

  // Sort by size descending
  communities.sort((a, b) => b.entityCount - a.entityCount);

  // Store results
  storeCommunities(db, communities);

  return { communities, totalEntities: entities.length };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function storeCommunities(db: DatabaseSync, communities: Community[]): void {
  const now = Date.now();

  // Clear old data
  db.exec(`DELETE FROM community_members`);
  db.exec(`DELETE FROM communities`);

  const insertCommunity = db.prepare(
    `INSERT INTO communities (id, label, entity_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  );
  const insertMember = db.prepare(
    `INSERT INTO community_members (community_id, entity_id) VALUES (?, ?)`,
  );

  for (const community of communities) {
    insertCommunity.run(community.id, community.label, community.entityCount, now, now);
    for (const entityId of community.entityIds) {
      insertMember.run(community.id, entityId);
    }
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Get all stored communities, sorted by entity count descending.
 */
export function getCommunities(engine: MemoryGraphEngine): Community[] {
  const db = engine.getDb();
  const rows = db
    .prepare(`SELECT id, label, entity_count FROM communities ORDER BY entity_count DESC`)
    .all() as Array<{ id: string; label: string | null; entity_count: number }>;

  return rows.map((row) => {
    const members = db
      .prepare(`SELECT entity_id FROM community_members WHERE community_id = ?`)
      .all(row.id) as Array<{ entity_id: string }>;
    return {
      id: row.id,
      label: row.label,
      entityCount: row.entity_count,
      entityIds: members.map((m) => m.entity_id),
    };
  });
}

/**
 * Get the community containing a specific entity.
 * Returns null if entity is not in any community.
 */
export function getCommunityForEntity(
  engine: MemoryGraphEngine,
  entityId: string,
): Community | null {
  const db = engine.getDb();
  const row = db
    .prepare(
      `SELECT c.id, c.label, c.entity_count FROM communities c ` +
        `JOIN community_members cm ON cm.community_id = c.id ` +
        `WHERE cm.entity_id = ? LIMIT 1`,
    )
    .get(entityId) as { id: string; label: string | null; entity_count: number } | undefined;

  if (!row) return null;

  const members = db
    .prepare(`SELECT entity_id FROM community_members WHERE community_id = ?`)
    .all(row.id) as Array<{ entity_id: string }>;

  return {
    id: row.id,
    label: row.label,
    entityCount: row.entity_count,
    entityIds: members.map((m) => m.entity_id),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/graph-community.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All 150+ tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/host/graph-community.ts src/__tests__/graph-community.test.ts
git commit -m "feat(3.1): community detection via BFS connected components"
```

---

### Task 3: Multi-Hop Path Finding

**Files:**
- Modify: `src/host/graph-engine.ts` — add `findPaths` method
- Create: `src/__tests__/graph-paths.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/graph-paths.test.ts`:

```typescript
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import { createTestDb } from "./test-helpers.js";

describe("multi-hop path finding", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  describe("findPaths", () => {
    it("finds direct path (1 hop)", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

      const paths = engine.findPaths(a.id, b.id, { maxDepth: 3 });

      expect(paths.length).toBeGreaterThanOrEqual(1);
      expect(paths[0]!.steps.length).toBe(1);
      expect(paths[0]!.steps[0]!.fromName).toBe("A");
      expect(paths[0]!.steps[0]!.toName).toBe("B");
      expect(paths[0]!.steps[0]!.relation).toBe("relates");
    });

    it("finds 2-hop path", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      const c = engine.upsertEntity({ name: "C", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "knows" });
      engine.addEdge({ fromId: b.id, toId: c.id, relation: "works_on" });

      const paths = engine.findPaths(a.id, c.id, { maxDepth: 3 });

      expect(paths.length).toBeGreaterThanOrEqual(1);
      expect(paths[0]!.steps.length).toBe(2);
      expect(paths[0]!.steps[0]!.fromName).toBe("A");
      expect(paths[0]!.steps[1]!.toName).toBe("C");
    });

    it("finds multiple paths", () => {
      // A -> B -> D and A -> C -> D
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      const c = engine.upsertEntity({ name: "C", type: "concept" });
      const d = engine.upsertEntity({ name: "D", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "r1" });
      engine.addEdge({ fromId: b.id, toId: d.id, relation: "r2" });
      engine.addEdge({ fromId: a.id, toId: c.id, relation: "r3" });
      engine.addEdge({ fromId: c.id, toId: d.id, relation: "r4" });

      const paths = engine.findPaths(a.id, d.id, { maxDepth: 3 });

      expect(paths.length).toBe(2);
      // Shorter paths first
      expect(paths[0]!.steps.length).toBeLessThanOrEqual(paths[1]!.steps.length);
    });

    it("respects maxDepth", () => {
      // A -> B -> C -> D (3 hops)
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      const c = engine.upsertEntity({ name: "C", type: "concept" });
      const d = engine.upsertEntity({ name: "D", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "r1" });
      engine.addEdge({ fromId: b.id, toId: c.id, relation: "r2" });
      engine.addEdge({ fromId: c.id, toId: d.id, relation: "r3" });

      const paths2 = engine.findPaths(a.id, d.id, { maxDepth: 2 });
      expect(paths2.length).toBe(0); // too deep

      const paths3 = engine.findPaths(a.id, d.id, { maxDepth: 3 });
      expect(paths3.length).toBe(1);
    });

    it("respects maxPaths limit", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      const c = engine.upsertEntity({ name: "C", type: "concept" });
      const d = engine.upsertEntity({ name: "D", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "r1" });
      engine.addEdge({ fromId: b.id, toId: d.id, relation: "r2" });
      engine.addEdge({ fromId: a.id, toId: c.id, relation: "r3" });
      engine.addEdge({ fromId: c.id, toId: d.id, relation: "r4" });

      const paths = engine.findPaths(a.id, d.id, { maxDepth: 3, maxPaths: 1 });
      expect(paths.length).toBe(1);
    });

    it("returns empty when no path exists", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      // No edge between them

      const paths = engine.findPaths(a.id, b.id, { maxDepth: 3 });
      expect(paths.length).toBe(0);
    });

    it("returns empty for same source and target", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const paths = engine.findPaths(a.id, a.id, { maxDepth: 3 });
      expect(paths.length).toBe(0);
    });

    it("handles nonexistent entities", () => {
      const paths = engine.findPaths("nonexistent1", "nonexistent2", { maxDepth: 3 });
      expect(paths.length).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/graph-paths.test.ts`
Expected: FAIL — `findPaths` does not exist on MemoryGraphEngine.

- [ ] **Step 3: Add types to graph-engine.ts**

Add after the `GraphSubset` type (around line 105):

```typescript
export type PathStep = {
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  relation: string;
};

export type PathResult = {
  steps: PathStep[];
  length: number;
};

export type FindPathsOpts = {
  /** Max BFS depth. Default 3. */
  maxDepth?: number;
  /** Max paths to return. Default 10. */
  maxPaths?: number;
};
```

- [ ] **Step 4: Implement findPaths on MemoryGraphEngine**

Add to the `MemoryGraphEngine` class (after `getNeighbors`):

```typescript
/**
 * Find all paths between two entities up to maxDepth hops.
 * Uses BFS with path tracking. Returns paths sorted by length.
 */
findPaths(
  fromId: string,
  toId: string,
  opts?: FindPathsOpts,
): PathResult[] {
  const maxDepth = opts?.maxDepth ?? 3;
  const maxPaths = opts?.maxPaths ?? 10;

  if (fromId === toId) return [];

  const fromEntity = this.getEntity(fromId);
  const toEntity = this.getEntity(toId);
  if (!fromEntity || !toEntity) return [];

  const results: PathResult[] = [];

  // BFS queue: each entry is [currentEntityId, pathSoFar]
  type QueueEntry = [string, PathStep[]];
  const queue: QueueEntry[] = [[fromId, []]];

  // Track visited states to avoid cycles: "entityId -> set of visited entityIds on this path"
  const visited = new Map<string, Set<string>>();

  while (queue.length > 0 && results.length < maxPaths) {
    const [currentId, path] = queue.shift()!;

    if (path.length >= maxDepth) continue;

    // Get outgoing and incoming edges
    const edges = this.findEdges({
      entityId: currentId,
      activeOnly: true,
      limit: 100,
    });

    for (const edge of edges) {
      const isOutgoing = edge.from_id === currentId;
      const neighborId = isOutgoing ? edge.to_id : edge.from_id;
      const neighborName = isOutgoing
        ? (this.getEntity(edge.to_id)?.name ?? edge.to_id.slice(0, 8))
        : (this.getEntity(edge.from_id)?.name ?? edge.from_id.slice(0, 8));

      // Skip if this entity is already in the current path (avoid cycles)
      const pathEntityIds = new Set([fromId, ...path.map((s) => s.toId)]);
      if (pathEntityIds.has(neighborId)) continue;

      const step: PathStep = {
        fromId: currentId,
        fromName: path.length === 0 ? fromEntity.name : path[path.length - 1]!.toName,
        toId: neighborId,
        toName: neighborName,
        relation: edge.relation,
      };

      const newPath = [...path, step];

      if (neighborId === toId) {
        // Found a complete path
        results.push({ steps: newPath, length: newPath.length });
      } else if (newPath.length < maxDepth) {
        queue.push([neighborId, newPath]);
      }
    }
  }

  // Sort by length (shortest first)
  results.sort((a, b) => a.length - b.length);
  return results.slice(0, maxPaths);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/graph-paths.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/host/graph-engine.ts src/__tests__/graph-paths.test.ts
git commit -m "feat(3.3): multi-hop path finding via BFS with cycle detection"
```

---

### Task 4: Graph Visualization Export

**Files:**
- Create: `src/host/graph-export.ts`
- Create: `src/__tests__/graph-export.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/graph-export.test.ts`:

```typescript
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import { exportGraph, type ExportFormat } from "../host/graph-export.js";
import { createTestDb } from "./test-helpers.js";

describe("graph export", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  function createSampleGraph() {
    const a = engine.upsertEntity({ name: "Alice", type: "user" });
    const b = engine.upsertEntity({ name: "React", type: "concept" });
    const c = engine.upsertEntity({ name: "ProjectX", type: "project" });
    engine.addEdge({ fromId: a.id, toId: b.id, relation: "knows" });
    engine.addEdge({ fromId: a.id, toId: c.id, relation: "works_on" });
    engine.addEdge({ fromId: b.id, toId: c.id, relation: "used_in" });
    return { a, b, c };
  }

  describe("mermaid format", () => {
    it("produces valid Mermaid graph syntax", () => {
      createSampleGraph();
      const result = exportGraph(engine, { format: "mermaid" });

      expect(result.content).toContain("graph LR");
      expect(result.content).toContain("Alice");
      expect(result.content).toContain("React");
      expect(result.content).toContain("ProjectX");
      expect(result.content).toContain("knows");
      expect(result.content).toContain("works_on");
      expect(result.entityCount).toBe(3);
      expect(result.edgeCount).toBe(3);
    });

    it("sanitizes special characters in Mermaid", () => {
      const a = engine.upsertEntity({ name: "Node (test)", type: "concept" });
      const b = engine.upsertEntity({ name: "Node [v2]", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

      const result = exportGraph(engine, { format: "mermaid" });
      // Mermaid node IDs must not contain special chars
      expect(result.content).not.toContain("(");
      expect(result.content).not.toContain("[");
    });
  });

  describe("dot format", () => {
    it("produces valid DOT graph syntax", () => {
      createSampleGraph();
      const result = exportGraph(engine, { format: "dot" });

      expect(result.content).toContain("digraph");
      expect(result.content).toContain("Alice");
      expect(result.content).toContain("React");
      expect(result.content).toContain("->");
      expect(result.content).toContain("knows");
    });
  });

  describe("json format", () => {
    it("produces valid JSON with nodes and edges", () => {
      createSampleGraph();
      const result = exportGraph(engine, { format: "json" });

      const parsed = JSON.parse(result.content);
      expect(parsed.nodes.length).toBe(3);
      expect(parsed.edges.length).toBe(3);
      expect(parsed.nodes[0]).toHaveProperty("id");
      expect(parsed.nodes[0]).toHaveProperty("name");
      expect(parsed.nodes[0]).toHaveProperty("type");
      expect(parsed.edges[0]).toHaveProperty("from");
      expect(parsed.edges[0]).toHaveProperty("to");
      expect(parsed.edges[0]).toHaveProperty("relation");
    });
  });

  describe("options", () => {
    it("supports centerEntity option for focused export", () => {
      const { a } = createSampleGraph();
      const result = exportGraph(engine, {
        format: "mermaid",
        centerEntityId: a.id,
        depth: 1,
      });

      // Should include Alice and her direct neighbors
      expect(result.content).toContain("Alice");
      expect(result.entityCount).toBeLessThanOrEqual(3);
    });

    it("handles empty graph", () => {
      const result = exportGraph(engine, { format: "mermaid" });
      expect(result.entityCount).toBe(0);
      expect(result.edgeCount).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/graph-export.test.ts`
Expected: FAIL — `graph-export.js` does not exist.

- [ ] **Step 3: Implement graph-export.ts**

Create `src/host/graph-export.ts`:

```typescript
/**
 * Graph visualization export: Mermaid, DOT, JSON.
 * Pure formatting — no side effects, no dependencies.
 */

import type { MemoryGraphEngine, GraphSubset, Entity, Edge } from "./graph-engine.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExportFormat = "mermaid" | "dot" | "json";

export type ExportOpts = {
  /** Output format. Default "mermaid". */
  format?: ExportFormat;
  /** Center export around this entity (with depth). Omit for full graph. */
  centerEntityId?: string;
  /** BFS depth when centerEntityId is set. Default 2. */
  depth?: number;
  /** Max entities to include. Default 100. */
  maxEntities?: number;
};

export type ExportResult = {
  content: string;
  format: ExportFormat;
  entityCount: number;
  edgeCount: number;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function exportGraph(
  engine: MemoryGraphEngine,
  opts?: ExportOpts,
): ExportResult {
  const format = opts?.format ?? "mermaid";
  const maxEntities = opts?.maxEntities ?? 100;

  let subset: GraphSubset;

  if (opts?.centerEntityId) {
    const depth = opts.depth ?? 2;
    subset = engine.getNeighbors(opts.centerEntityId, depth);
  } else {
    // Export all active entities and edges
    const entities = engine.getActiveEntities().slice(0, maxEntities);
    const entityIds = new Set(entities.map((e) => e.id));

    const allEdges: Edge[] = [];
    for (const id of entityIds) {
      const edges = engine.findEdges({ entityId: id, activeOnly: true, limit: 50 });
      for (const edge of edges) {
        if (entityIds.has(edge.from_id) && entityIds.has(edge.to_id)) {
          allEdges.push(edge);
        }
      }
    }

    // Deduplicate edges
    const seenEdges = new Set<string>();
    const uniqueEdges = allEdges.filter((e) => {
      if (seenEdges.has(e.id)) return false;
      seenEdges.add(e.id);
      return true;
    });

    subset = { entities, edges: uniqueEdges };
  }

  let content: string;
  switch (format) {
    case "mermaid":
      content = toMermaid(subset);
      break;
    case "dot":
      content = toDot(subset);
      break;
    case "json":
      content = toJson(subset);
      break;
  }

  return {
    content,
    format,
    entityCount: subset.entities.length,
    edgeCount: subset.edges.length,
  };
}

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

function toMermaid(subset: GraphSubset): string {
  const lines: string[] = ["graph LR"];

  // Build ID map (Mermaid IDs must be alphanumeric + underscore)
  const idMap = new Map<string, string>();
  for (let i = 0; i < subset.entities.length; i++) {
    const entity = subset.entities[i]!;
    const safeId = `n${i}`;
    idMap.set(entity.id, safeId);
    const safeName = entity.name.replace(/[\(\)\[\]\{\}"<>]/g, "_");
    lines.push(`    ${safeId}["${safeName} (${entity.type})"]`);
  }

  for (const edge of subset.edges) {
    const fromId = idMap.get(edge.from_id);
    const toId = idMap.get(edge.to_id);
    if (fromId && toId) {
      const safeRelation = edge.relation.replace(/[\(\)\[\]\{\}"<>]/g, "_");
      lines.push(`    ${fromId} -->|"${safeRelation}"| ${toId}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// DOT (Graphviz)
// ---------------------------------------------------------------------------

function toDot(subset: GraphSubset): string {
  const lines: string[] = ["digraph MemoryGraph {"];

  for (const entity of subset.entities) {
    const safeName = entity.name.replace(/"/g, '\\"');
    lines.push(`  "${entity.id}" [label="${safeName} (${entity.type})"];`);
  }

  for (const edge of subset.edges) {
    const safeRelation = edge.relation.replace(/"/g, '\\"');
    lines.push(`  "${edge.from_id}" -> "${edge.to_id}" [label="${safeRelation}"];`);
  }

  lines.push("}");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

function toJson(subset: GraphSubset): string {
  const data = {
    nodes: subset.entities.map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      summary: e.summary,
      confidence: e.confidence,
    })),
    edges: subset.edges.map((e) => ({
      id: e.id,
      from: e.from_id,
      to: e.to_id,
      relation: e.relation,
      weight: e.weight,
    })),
  };
  return JSON.stringify(data, null, 2);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/graph-export.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/host/graph-export.ts src/__tests__/graph-export.test.ts
git commit -m "feat(3.5): graph visualization export — Mermaid, DOT, JSON"
```

---

### Task 5: Agent Tools & Exports

**Files:**
- Modify: `src/host/graph-tools.ts` — add 3 new tools
- Modify: `src/index.ts` — export new modules and types

- [ ] **Step 1: Add memoryDetectCommunities tool**

In `src/host/graph-tools.ts`, add imports at top:

```typescript
import { detectCommunities, getCommunities, getCommunityForEntity, type Community } from "./graph-community.js";
import { exportGraph, type ExportFormat } from "./graph-export.js";
```

Add tool functions at the end of the file:

```typescript
// ---------------------------------------------------------------------------
// Tool: memory_detect_communities
// ---------------------------------------------------------------------------

export type MemoryDetectCommunitiesInput = {
  activeOnly?: boolean;
};

export type MemoryDetectCommunitiesOutput = {
  communityCount: number;
  totalEntities: number;
  communities: Array<{
    id: string;
    entityCount: number;
    sampleEntities: string[];
  }>;
};

export function memoryDetectCommunities(
  engine: MemoryGraphEngine,
  input: MemoryDetectCommunitiesInput,
): MemoryDetectCommunitiesOutput {
  const result = detectCommunities(engine, { activeOnly: input.activeOnly ?? true });

  return {
    communityCount: result.communities.length,
    totalEntities: result.totalEntities,
    communities: result.communities.slice(0, 20).map((c) => ({
      id: c.id,
      entityCount: c.entityCount,
      sampleEntities: c.entityIds
        .slice(0, 5)
        .map((id) => engine.getEntity(id)?.name ?? id.slice(0, 8)),
    })),
  };
}

// ---------------------------------------------------------------------------
// Tool: memory_find_paths
// ---------------------------------------------------------------------------

export type MemoryFindPathsInput = {
  from: string;
  to: string;
  maxDepth?: number;
  maxPaths?: number;
};

export type MemoryFindPathsOutput = {
  found: boolean;
  paths: Array<{
    steps: Array<{ from: string; relation: string; to: string }>;
    length: number;
  }>;
  formatted: string;
};

export function memoryFindPaths(
  engine: MemoryGraphEngine,
  input: MemoryFindPathsInput,
): MemoryFindPathsOutput {
  // Resolve from/to by name or ID
  let fromEntity = engine.getEntity(input.from);
  if (!fromEntity) {
    const matches = engine.findEntities({ name: input.from, activeOnly: true, limit: 1 });
    fromEntity = matches[0] ?? null;
  }
  let toEntity = engine.getEntity(input.to);
  if (!toEntity) {
    const matches = engine.findEntities({ name: input.to, activeOnly: true, limit: 1 });
    toEntity = matches[0] ?? null;
  }

  if (!fromEntity || !toEntity) {
    return {
      found: false,
      paths: [],
      formatted: `Entity not found: ${!fromEntity ? input.from : input.to}`,
    };
  }

  const paths = engine.findPaths(fromEntity.id, toEntity.id, {
    maxDepth: input.maxDepth ?? 3,
    maxPaths: input.maxPaths ?? 5,
  });

  if (paths.length === 0) {
    return {
      found: false,
      paths: [],
      formatted: `No path found between "${fromEntity.name}" and "${toEntity.name}" within ${input.maxDepth ?? 3} hops`,
    };
  }

  const formattedPaths = paths.map((p, i) => {
    const chain = p.steps.map((s) => `${s.fromName} --[${s.relation}]--> ${s.toName}`).join(", ");
    return `Path ${i + 1} (${p.length} hops): ${chain}`;
  });

  return {
    found: true,
    paths: paths.map((p) => ({
      steps: p.steps.map((s) => ({
        from: s.fromName,
        relation: s.relation,
        to: s.toName,
      })),
      length: p.length,
    })),
    formatted: `## Paths: ${fromEntity.name} → ${toEntity.name}\n${formattedPaths.join("\n")}`,
  };
}

// ---------------------------------------------------------------------------
// Tool: memory_export_graph
// ---------------------------------------------------------------------------

export type MemoryExportGraphInput = {
  format?: ExportFormat;
  centerEntity?: string;
  depth?: number;
};

export type MemoryExportGraphOutput = {
  content: string;
  format: ExportFormat;
  entityCount: number;
  edgeCount: number;
};

export function memoryExportGraph(
  engine: MemoryGraphEngine,
  input: MemoryExportGraphInput,
): MemoryExportGraphOutput {
  let centerEntityId: string | undefined;
  if (input.centerEntity) {
    let entity = engine.getEntity(input.centerEntity);
    if (!entity) {
      const matches = engine.findEntities({ name: input.centerEntity, activeOnly: true, limit: 1 });
      entity = matches[0] ?? null;
    }
    centerEntityId = entity?.id;
  }

  const result = exportGraph(engine, {
    format: input.format ?? "mermaid",
    centerEntityId,
    depth: input.depth,
  });

  return {
    content: result.content,
    format: result.format,
    entityCount: result.entityCount,
    edgeCount: result.edgeCount,
  };
}
```

- [ ] **Step 2: Export from index.ts**

In `src/index.ts`, add:

```typescript
// Community detection
export {
  detectCommunities,
  getCommunities,
  getCommunityForEntity,
  type Community,
  type DetectionResult,
  type DetectionOpts,
} from "./host/graph-community.js";

// Graph export
export {
  exportGraph,
  type ExportFormat,
  type ExportOpts as GraphExportOpts,
  type ExportResult as GraphExportResult,
} from "./host/graph-export.js";
```

Also add to the existing graph-engine exports:

```typescript
export {
  // ... existing exports ...
  type PathStep,
  type PathResult,
  type FindPathsOpts,
} from "./host/graph-engine.js";
```

And add to the agent tools exports:

```typescript
export {
  // ... existing exports ...
  memoryDetectCommunities,
  memoryFindPaths,
  memoryExportGraph,
  type MemoryDetectCommunitiesInput,
  type MemoryDetectCommunitiesOutput,
  type MemoryFindPathsInput,
  type MemoryFindPathsOutput,
  type MemoryExportGraphInput,
  type MemoryExportGraphOutput,
} from "./host/graph-tools.js";
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/host/graph-tools.ts src/index.ts
git commit -m "feat(3.x): add community, path-finding, and export agent tools"
```

---

### Task 6: Integration & Version Bump

**Files:**
- Modify: `package.json` — bump to 0.5.0
- Modify: `CHANGELOG.md` — add v0.5.0 section
- Modify: `ROADMAP.md` — mark Phase 3a items as complete

- [ ] **Step 1: Update CHANGELOG.md**

Add at the top:

```markdown
## [0.5.0] - 2026-04-28

### Added
- **Community detection**: BFS-based connected components algorithm detects entity clusters. Results stored in `communities`/`community_members` tables. `detectCommunities()`, `getCommunities()`, `getCommunityForEntity()` APIs.
- **Multi-hop path finding**: `findPaths(fromId, toId)` discovers all paths between two entities up to configurable depth via BFS with cycle detection. Returns paths sorted by length.
- **Graph visualization export**: `exportGraph()` produces Mermaid, DOT, or JSON output. Supports full-graph and entity-centered (with depth) export. Special characters sanitized for Mermaid/DOT.
- **New agent tools**: `memoryDetectCommunities`, `memoryFindPaths`, `memoryExportGraph`.
```

- [ ] **Step 2: Update ROADMAP.md**

Change `## 📋 Phase 3 (v0.5)` to `## ✅ Phase 3a (v0.5)` and mark items 3.1, 3.3, 3.5 as done.

- [ ] **Step 3: Bump version**

In `package.json`, change `"version": "0.4.0"` to `"version": "0.5.0"`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json CHANGELOG.md ROADMAP.md
git commit -m "chore(v0.5): bump version, update changelog and roadmap"
```

---

## Self-Review

**Spec coverage:**
- 3.1 Community detection → Tasks 1, 2 ✅
- 3.3 Multi-hop reasoning → Task 3 ✅
- 3.5 Visualization export → Task 4 ✅
- Agent tools → Task 5 ✅
- Version/docs → Task 6 ✅

**Placeholder scan:** No TBD/TODO/placeholder found. All code blocks are complete.

**Type consistency:**
- `Community` type used consistently in graph-community.ts and graph-tools.ts
- `PathStep`, `PathResult`, `FindPathsOpts` defined in engine, used in tools
- `ExportFormat`, `ExportResult` defined in export, used in tools
- `findPaths` signature matches between engine method and tool wrapper

**Potential issue:** `findPaths` uses `this.findEdges` which has a default limit of 100. For highly connected nodes, this could miss paths. The limit is configurable via EdgeQuery but the findPaths implementation doesn't expose it. Acceptable for v0.5 — can be optimized later.
