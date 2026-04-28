# Phase 2 (v0.4) — Performance & Search Optimization

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace O(n) full-scan vector search with ANN, add incremental embedding updates, batch operations API, FTS score normalization, and search result caching.

**Architecture:** sqlite-vec provides an optional ANN index (vec0 virtual table) that the search layer uses when available, falling back to the current JS cosine scan. Embedding updates become lazy via content-hash comparison. Batch APIs wrap multi-item operations in a single transaction. An LRU cache with TTL avoids redundant search computation.

**Tech Stack:** sqlite-vec (optional peer dep), node:crypto (hash), pure TS (no new runtime deps for cache/batch/FTS)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/host/graph-schema.ts` | Modify | Add `content_hash` column, `entities_vec` virtual table, vec availability flag |
| `src/host/graph-engine.ts` | Modify | Incremental embedding, batch upsert/edge, `content_hash` tracking |
| `src/host/graph-search.ts` | Modify | ANN search path, FTS normalization, LRU cache |
| `src/host/graph-vec.ts` | **Create** | sqlite-vec adapter (create vec table, insert/query helpers) |
| `src/index.ts` | Modify | Export new types + batch APIs |
| `package.json` | Modify | Add `sqlite-vec` as optional peer dependency |
| `src/__tests__/graph-vec.test.ts` | **Create** | ANN search tests |
| `src/__tests__/graph-batch.test.ts` | **Create** | Batch operations tests |
| `src/__tests__/graph-search.test.ts` | Modify | FTS normalization + cache tests |
| `src/__tests__/test-helpers.ts` | Modify | Add vec-aware test helper |

---

### Task 1: sqlite-vec Adapter (`graph-vec.ts`)

**Files:**
- Create: `src/host/graph-vec.ts`
- Create: `src/__tests__/graph-vec.test.ts`
- Modify: `src/host/graph-schema.ts:72-204`
- Modify: `src/host/graph-search.ts:224-265`

#### Step 1.1: Write the vec adapter with feature detection

Create `src/host/graph-vec.ts`:

```typescript
import type { DatabaseSync } from "node:sqlite";

export type VecAvailability = {
  available: boolean;
  error?: string;
};

/**
 * Try to load sqlite-vec and create the vec0 virtual table.
 * Returns availability status — callers must check before using ANN queries.
 */
export function ensureVecIndex(
  db: DatabaseSync,
  dimensions: number,
): VecAvailability {
  try {
    // sqlite-vec registers itself via the extension mechanism.
    // With node:sqlite we enable extensions and load the .dylib/.so.
    // If sqlite-vec is not installed, this throws.
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS entities_vec USING vec0(id TEXT, embedding FLOAT[${dimensions}])`);
    return { available: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { available: false, error: message };
  }
}

/**
 * Insert or update a vector in the ANN index.
 * No-op if vec is not available.
 */
export function vecUpsert(
  db: DatabaseSync,
  entityId: string,
  embedding: number[],
  available: boolean,
): void {
  if (!available) return;
  // vec0 uses INSERT OR REPLACE semantics
  db.prepare(
    `INSERT OR REPLACE INTO entities_vec (id, embedding) VALUES (?, vec(?))`,
  ).run(entityId, JSON.stringify(embedding));
}

/**
 * Remove a vector from the ANN index (on entity invalidation).
 */
export function vecRemove(
  db: DatabaseSync,
  entityId: string,
  available: boolean,
): void {
  if (!available) return;
  db.prepare(`DELETE FROM entities_vec WHERE id = ?`).run(entityId);
}

/**
 * Query the ANN index for nearest neighbors.
 * Returns entity IDs sorted by distance (ascending).
 */
export function vecKnn(
  db: DatabaseSync,
  queryEmbedding: number[],
  k: number,
  available: boolean,
): Array<{ id: string; distance: number }> {
  if (!available) return [];
  try {
    const rows = db
      .prepare(
        `SELECT id, distance FROM entities_vec WHERE embedding MATCH vec(?) ORDER BY distance LIMIT k`,
      )
      .all(JSON.stringify(queryEmbedding), k) as Array<{ id: string; distance: number }>;
    return rows;
  } catch {
    return [];
  }
}

/**
 * Sync the vec index for all entities that have embeddings but are missing from vec.
 * Used during schema init and migration.
 */
export function vecSyncAll(
  db: DatabaseSync,
  available: boolean,
): number {
  if (!available) return 0;
  // Find entities with embeddings not yet in vec
  const rows = db
    .prepare(
      `SELECT id, embedding FROM entities WHERE embedding IS NOT NULL AND valid_until IS NULL`,
    )
    .all() as Array<{ id: string; embedding: Buffer }>;

  let synced = 0;
  for (const row of rows) {
    try {
      const { deserializeEmbedding } = require("./graph-engine.js");
      const vec = deserializeEmbedding(row.embedding);
      vecUpsert(db, row.id, vec, true);
      synced++;
    } catch {
      // Skip corrupted
    }
  }
  return synced;
}
```

#### Step 1.2: Write the failing test

Create `src/__tests__/graph-vec.test.ts`:

```typescript
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./test-helpers.js";
import { ensureVecIndex, vecUpsert, vecRemove, vecKnn } from "../host/graph-vec.js";

describe("graph-vec", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  describe("ensureVecIndex", () => {
    it("returns availability status", () => {
      const result = ensureVecIndex(db, 3);
      // sqlite-vec may or may not be available in test env
      expect(result).toHaveProperty("available");
      expect(typeof result.available).toBe("boolean");
    });
  });

  describe("vecKnn (when available)", () => {
    it("returns nearest neighbors sorted by distance", () => {
      const { available } = ensureVecIndex(db, 3);
      if (!available) return; // skip if sqlite-vec not installed

      vecUpsert(db, "a", [1, 0, 0], available);
      vecUpsert(db, "b", [0, 1, 0], available);
      vecUpsert(db, "c", [0.9, 0.1, 0], available);

      const results = vecKnn(db, [1, 0, 0], 2, available);
      expect(results.length).toBe(2);
      expect(results[0]!.id).toBe("a");
      expect(results[0]!.distance).toBeLessThan(results[1]!.distance);
    });

    it("returns empty when not available", () => {
      const results = vecKnn(db, [1, 0, 0], 5, false);
      expect(results).toEqual([]);
    });
  });

  describe("vecRemove", () => {
    it("removes entity from vec index", () => {
      const { available } = ensureVecIndex(db, 3);
      if (!available) return;

      vecUpsert(db, "x", [1, 0, 0], available);
      vecRemove(db, "x", available);

      const results = vecKnn(db, [1, 0, 0], 10, available);
      expect(results.find((r) => r.id === "x")).toBeUndefined();
    });
  });
});
```

#### Step 1.3: Run test to verify it fails

Run: `npx vitest run src/__tests__/graph-vec.test.ts`
Expected: FAIL — `graph-vec.js` does not exist yet.

#### Step 1.4: Implement `graph-vec.ts`

Write the file as shown in Step 1.1. Note: replace `require("./graph-engine.js")` with proper ESM import at the top:

```typescript
import { deserializeEmbedding } from "./graph-engine.js";
```

And update `vecSyncAll` to use it directly.

#### Step 1.5: Run test to verify it passes

Run: `npx vitest run src/__tests__/graph-vec.test.ts`
Expected: PASS (tests that check `available === false` always pass; vec-dependent tests skip gracefully if sqlite-vec is not installed in the test environment).

#### Step 1.6: Wire vec into schema init

Modify `src/host/graph-schema.ts` — in `ensureGraphSchema`, after FTS setup, add vec initialization:

```typescript
// After the FTS block (~line 176), add:

// -- sqlite-vec ANN index ---------------------------------------------------
let vecAvailable = false;
let vecError: string | undefined;
try {
  const vecResult = ensureVecIndex(db, 1536); // default dim, adjustable
  vecAvailable = vecResult.available;
  vecError = vecResult.error;
} catch {
  // vec not available — non-fatal
}

// Update return type to include vec info
```

Update the return type of `ensureGraphSchema` to:

```typescript
{ entityFtsAvailable: boolean; entityFtsError?: string; vecAvailable: boolean; vecError?: string }
```

#### Step 1.7: Replace vector search in `graph-search.ts`

Replace `vectorSearchEntities` (lines 224-265) with a two-path implementation:

```typescript
function vectorSearchEntities(
  db: DatabaseSync,
  engine: MemoryGraphEngine,
  queryEmbedding: number[],
  limit: number,
  activeOnly: boolean,
): VectorHit[] {
  // Path 1: ANN via sqlite-vec (if available)
  const vecAvail = engine.vecAvailable?.() ?? false;
  if (vecAvail) {
    const annResults = vecKnn(db, queryEmbedding, limit * 2, true);
    if (annResults.length > 0) {
      // Filter for activeOnly if needed
      const hits: VectorHit[] = [];
      for (const r of annResults) {
        if (activeOnly) {
          const entity = engine.getEntity(r.id);
          if (!entity || entity.valid_until !== null) continue;
        }
        // Convert distance to similarity (sqlite-vec uses L2 distance)
        const similarity = 1 / (1 + r.distance);
        hits.push({ id: r.id, similarity });
        if (hits.length >= limit) break;
      }
      return hits;
    }
  }

  // Path 2: Fallback — full scan (current implementation, unchanged)
  try {
    const scanLimit = Math.min(VECTOR_SCAN_LIMIT, Math.max(limit * 2, 100));
    const rows = db
      .prepare(
        `SELECT id, embedding FROM entities WHERE embedding IS NOT NULL ` +
          `${activeOnly ? "AND valid_until IS NULL " : ""}` +
          `ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(scanLimit) as Array<{ id: string; embedding: string | Buffer }>;

    const hits: VectorHit[] = [];
    for (const row of rows) {
      try {
        let stored: number[];
        if (typeof row.embedding === "string") {
          stored = JSON.parse(row.embedding) as number[];
        } else {
          stored = deserializeEmbedding(row.embedding as Buffer);
        }
        const sim = cosineSimilarity(queryEmbedding, stored);
        if (sim > 0) {
          hits.push({ id: row.id, similarity: sim });
        }
      } catch {
        continue;
      }
    }
    hits.sort((a, b) => b.similarity - a.similarity);
    return hits.slice(0, limit);
  } catch {
    return [];
  }
}
```

Add `vecAvailable()` method to `MemoryGraphEngine`:

```typescript
// In graph-engine.ts, add to MemoryGraphEngine class:
private _vecAvailable = false;

setVecAvailable(available: boolean): void {
  this._vecAvailable = available;
}

vecAvailable(): boolean {
  return this._vecAvailable;
}
```

Update `searchGraph` call to pass engine to `vectorSearchEntities`:

```typescript
// Line ~110, change:
const vectorHits = vectorSearchEntities(db, queryEmbedding, candidateLimit, activeOnly);
// To:
const vectorHits = vectorSearchEntities(db, engine, queryEmbedding, candidateLimit, activeOnly);
```

#### Step 1.8: Update vec on entity write

In `graph-engine.ts` `upsertEntity`, after writing to the entities table, sync the vec index:

```typescript
// After syncEntityFts(this.db, row); (both in update and insert paths):
if (this._vecAvailable) {
  const { vecUpsert } = require("./graph-vec.js");
  if (embedding) {
    vecUpsert(this.db, id ?? existing.id, embedding, true);
  }
}
```

In `invalidateEntity`, after removeEntityFts:

```typescript
if (this._vecAvailable) {
  const { vecRemove } = require("./graph-vec.js");
  vecRemove(this.db, id, true);
}
```

Use proper ESM imports instead of require — import at top of file.

#### Step 1.9: Commit

```bash
git add src/host/graph-vec.ts src/__tests__/graph-vec.test.ts src/host/graph-schema.ts src/host/graph-search.ts src/host/graph-engine.ts
git commit -m "feat(2.1): add sqlite-vec ANN index with graceful fallback to full scan"
```

---

### Task 2: Incremental Embedding Updates

**Files:**
- Modify: `src/host/graph-schema.ts` — add `content_hash` column
- Modify: `src/host/graph-engine.ts` — hash check before embedding
- Modify: `src/__tests__/graph-engine.test.ts` — add incremental tests

#### Step 2.1: Write the failing test

Add to `src/__tests__/graph-engine.test.ts`:

```typescript
describe("incremental embedding", () => {
  it("skips embedFn when content has not changed", () => {
    let callCount = 0;
    const countingEmbed: EmbedFn = (text) => {
      callCount++;
      return [1, 0, 0];
    };
    const eng = new MemoryGraphEngine(db, { embedFn: countingEmbed });

    eng.upsertEntity({ name: "A", type: "concept", summary: "hello" });
    expect(callCount).toBe(1);

    // Same name + same summary → should NOT re-embed
    eng.upsertEntity({ name: "A", type: "concept", summary: "hello" });
    expect(callCount).toBe(1); // still 1, not 2
  });

  it("re-embeds when summary changes", () => {
    let callCount = 0;
    const countingEmbed: EmbedFn = (text) => {
      callCount++;
      return [1, 0, 0];
    };
    const eng = new MemoryGraphEngine(db, { embedFn: countingEmbed });

    eng.upsertEntity({ name: "A", type: "concept", summary: "v1" });
    expect(callCount).toBe(1);

    eng.upsertEntity({ name: "A", type: "concept", summary: "v2" });
    expect(callCount).toBe(2);
  });
});
```

#### Step 2.2: Run test to verify it fails

Run: `npx vitest run src/__tests__/graph-engine.test.ts -t "incremental"`
Expected: FAIL — `callCount` is 2 on first test (embedFn called every time).

#### Step 2.3: Add `content_hash` column

In `graph-schema.ts`, inside `ensureGraphSchema`, after the access_count migration:

```typescript
// Content hash for incremental embedding
try { db.exec(`ALTER TABLE entities ADD COLUMN content_hash TEXT`); } catch { /* already exists */ }
```

Add index:

```typescript
db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_content_hash ON entities(content_hash);`);
```

#### Step 2.4: Implement hash check in `upsertEntity`

In `graph-engine.ts`, add import:

```typescript
import { createHash } from "node:crypto";
```

Add helper:

```typescript
function computeContentHash(name: string, summary?: string | null): string {
  const content = name + "\0" + (summary ?? "");
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
```

In `upsertEntity`, replace the embedding generation block (lines ~162-171) with:

```typescript
// Auto-generate embedding via hook if not provided AND content changed
let embedding = input.embedding;
const newHash = computeContentHash(input.name, input.summary);
if (!embedding && this.embedFn) {
  // Check if content hash matches existing entity
  const shouldReembed = !existing || existing.content_hash !== newHash;
  if (shouldReembed) {
    try {
      const text = input.name + (input.summary ? " " + input.summary : "");
      embedding = this.embedFn(text);
    } catch {
      // Non-fatal
    }
  } else {
    // Content unchanged — keep existing embedding
    embedding = undefined; // don't overwrite
  }
}
```

In the UPDATE statement, add `content_hash`:

```typescript
`UPDATE entities SET summary = COALESCE(?, summary), embedding = COALESCE(?, embedding), ` +
  `confidence = ?, source = ?, updated_at = ?, content_hash = ? WHERE id = ?`,
// ...params: add newHash before existing.id
```

In the INSERT statement, add `content_hash`:

```typescript
`INSERT INTO entities (id, name, type, summary, embedding, confidence, source, valid_from, valid_until, created_at, updated_at, content_hash) ` +
  `VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
// ...params: add newHash at end
```

#### Step 2.5: Run test to verify it passes

Run: `npx vitest run src/__tests__/graph-engine.test.ts -t "incremental"`
Expected: PASS

#### Step 2.6: Run full test suite

Run: `npx vitest run`
Expected: All 128+ tests PASS.

#### Step 2.7: Commit

```bash
git add src/host/graph-schema.ts src/host/graph-engine.ts src/__tests__/graph-engine.test.ts
git commit -m "feat(2.2): incremental embedding — skip embedFn when content unchanged"
```

---

### Task 3: Batch Operations API

**Files:**
- Modify: `src/host/graph-engine.ts` — add `upsertEntities` and `addEdges`
- Create: `src/__tests__/graph-batch.test.ts`
- Modify: `src/host/graph-tools.ts` — add `memoryBatchStore` tool
- Modify: `src/index.ts` — export new APIs

#### Step 3.1: Write the failing test

Create `src/__tests__/graph-batch.test.ts`:

```typescript
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine, type EmbedFn } from "../host/graph-engine.js";
import { createTestDb } from "./test-helpers.js";

describe("batch operations", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  describe("upsertEntities", () => {
    it("creates multiple entities in one transaction", () => {
      const results = engine.upsertEntities([
        { name: "A", type: "concept" },
        { name: "B", type: "user" },
        { name: "C", type: "project" },
      ]);

      expect(results.length).toBe(3);
      expect(results[0]!.isNew).toBe(true);
      expect(results[1]!.isNew).toBe(true);
      expect(results[2]!.isNew).toBe(true);

      const stats = engine.stats();
      expect(stats.entities).toBe(3);
    });

    it("updates existing entities on re-run", () => {
      engine.upsertEntities([
        { name: "A", type: "concept", summary: "v1" },
      ]);

      const results = engine.upsertEntities([
        { name: "A", type: "concept", summary: "v2" },
      ]);

      expect(results[0]!.isNew).toBe(false);
      expect(results[0]!.summary).toBe("v2");
    });

    it("calls embedFn only once per entity (batch optimization)", () => {
      let callCount = 0;
      const countingEmbed: EmbedFn = (text) => {
        callCount++;
        return [1, 0, 0];
      };
      const embedEngine = new MemoryGraphEngine(db, { embedFn: countingEmbed });

      embedEngine.upsertEntities([
        { name: "A", type: "concept" },
        { name: "B", type: "concept" },
        { name: "C", type: "concept" },
      ]);

      expect(callCount).toBe(3); // once each, not more
    });
  });

  describe("addEdges", () => {
    it("creates multiple edges in one transaction", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      const c = engine.upsertEntity({ name: "C", type: "concept" });

      const edges = engine.addEdges([
        { fromId: a.id, toId: b.id, relation: "relates_to" },
        { fromId: b.id, toId: c.id, relation: "depends_on" },
      ]);

      expect(edges.length).toBe(2);
      expect(edges[0]!.relation).toBe("relates_to");
      expect(edges[1]!.relation).toBe("depends_on");
    });

    it("deduplicates edges within the batch", () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });

      const edges = engine.addEdges([
        { fromId: a.id, toId: b.id, relation: "relates_to", weight: 0.5 },
        { fromId: a.id, toId: b.id, relation: "relates_to", weight: 0.8 },
      ]);

      // Second should update weight, not create duplicate
      expect(edges.length).toBe(2); // both return Edge objects
      const found = engine.findEdges({ entityId: a.id });
      expect(found.length).toBe(1); // only one active edge
      expect(found[0]!.weight).toBe(0.8); // higher weight kept
    });
  });
});
```

#### Step 3.2: Run test to verify it fails

Run: `npx vitest run src/__tests__/graph-batch.test.ts`
Expected: FAIL — `upsertEntities` is not a function.

#### Step 3.3: Implement `upsertEntities`

Add to `MemoryGraphEngine` class in `graph-engine.ts`:

```typescript
/** Batch upsert multiple entities in a single transaction. */
upsertEntities(inputs: EntityInput[]): Array<Entity & { isNew: boolean }> {
  return this.runInTransaction(() => inputs.map((input) => this.upsertEntity(input)));
}
```

#### Step 3.4: Implement `addEdges`

```typescript
/** Batch create multiple edges in a single transaction. */
addEdges(inputs: EdgeInput[]): Edge[] {
  return this.runInTransaction(() => inputs.map((input) => this.addEdge(input)));
}
```

#### Step 3.5: Run test to verify it passes

Run: `npx vitest run src/__tests__/graph-batch.test.ts`
Expected: PASS

#### Step 3.6: Add `memoryBatchStore` tool

Add to `src/host/graph-tools.ts`:

```typescript
// ---------------------------------------------------------------------------
// Tool: memory_batch_store
// ---------------------------------------------------------------------------

export type MemoryBatchStoreInput = {
  entities: Array<{
    name: string;
    type: string;
    summary?: string;
    confidence?: number;
    relations?: Array<{ targetName: string; targetType: string; relation: string }>;
  }>;
};

export type MemoryBatchStoreOutput = {
  results: Array<{
    entityId: string;
    name: string;
    isNew: boolean;
    edgesCreated: number;
  }>;
  totalEntities: number;
  totalEdges: number;
};

export function memoryBatchStore(
  engine: MemoryGraphEngine,
  input: MemoryBatchStoreInput,
): MemoryBatchStoreOutput {
  const results: MemoryBatchStoreOutput["results"] = [];
  let totalEdges = 0;

  engine.runInTransaction(() => {
    for (const item of input.entities) {
      const entity = engine.upsertEntity({
        name: item.name,
        type: item.type,
        summary: item.summary,
        confidence: item.confidence,
        source: "manual",
      });

      let edgesCreated = 0;
      if (item.relations) {
        for (const rel of item.relations) {
          const target = engine.upsertEntity({
            name: rel.targetName,
            type: rel.targetType,
            source: "manual",
          });
          engine.addEdge({
            fromId: entity.id,
            toId: target.id,
            relation: rel.relation,
          });
          edgesCreated++;
        }
      }

      results.push({
        entityId: entity.id,
        name: entity.name,
        isNew: entity.isNew,
        edgesCreated,
      });
      totalEdges += edgesCreated;
    }
  });

  return {
    results,
    totalEntities: results.length,
    totalEdges,
  };
}
```

#### Step 3.7: Export from `src/index.ts`

Add to exports:

```typescript
export {
  memoryBatchStore,
  type MemoryBatchStoreInput,
  type MemoryBatchStoreOutput,
} from "./host/graph-tools.js";
```

#### Step 3.8: Run full test suite

Run: `npx vitest run`
Expected: All tests PASS.

#### Step 3.9: Commit

```bash
git add src/host/graph-engine.ts src/host/graph-tools.ts src/index.ts src/__tests__/graph-batch.test.ts
git commit -m "feat(2.3): batch operations — upsertEntities, addEdges, memoryBatchStore"
```

---

### Task 4: FTS Score Normalization

**Files:**
- Modify: `src/host/graph-search.ts:86-106`
- Modify: `src/__tests__/graph-search.test.ts`

#### Step 4.1: Write the failing test

Add to `src/__tests__/graph-search.test.ts`:

```typescript
describe("FTS score normalization", () => {
  it("returns meaningful scores even with small document sets", () => {
    // Create a handful of entities
    engine.upsertEntity({ name: "React", type: "concept", summary: "UI library by Meta" });
    engine.upsertEntity({ name: "Vue", type: "concept", summary: "Progressive framework" });
    engine.upsertEntity({ name: "Angular", type: "concept", summary: "Platform for web apps" });

    const results = searchGraph(db, engine, "React", {
      vectorWeight: 0,
      ftsWeight: 1.0,
      graphWeight: 0,
      minScore: 0,
    });

    expect(results.length).toBeGreaterThan(0);
    // With normalization, score should be meaningfully > 0 (not tiny like 0.001)
    expect(results[0]!.score).toBeGreaterThan(0.1);
  });

  it("gives higher score to better matches", () => {
    engine.upsertEntity({ name: "React", type: "concept", summary: "UI library" });
    engine.upsertEntity({ name: "ReactiveX", type: "concept", summary: "Reactive extensions" });

    const results = searchGraph(db, engine, "React", {
      vectorWeight: 0,
      ftsWeight: 1.0,
      graphWeight: 0,
      minScore: 0,
    });

    const react = results.find((r) => r.entity.name === "React");
    const reactivex = results.find((r) => r.entity.name === "ReactiveX");

    if (react && reactivex) {
      expect(react.score).toBeGreaterThan(reactivex.score);
    }
  });
});
```

#### Step 4.2: Run test to verify it fails (or shows poor scores)

Run: `npx vitest run src/__tests__/graph-search.test.ts -t "FTS score normalization"`
Expected: First test may fail — scores with small doc sets are near 0.

#### Step 4.3: Implement normalized FTS scoring

Replace the FTS normalization block in `searchGraph` (lines ~87-106) with:

```typescript
// Path 1: FTS search
try {
  const ftsResults = searchEntityFts(db, query, { limit: candidateLimit });
  if (ftsResults.length > 0) {
    // FTS5 BM25 rank is negative; more negative = better match.
    // Normalize using sigmoid-like transform to map to 0-1 range.
    // This works well even with small document sets.
    for (const hit of ftsResults) {
      // BM25 rank typically ranges from -10 to 0.
      // Transform: score = 1 / (1 + e^(rank)) maps (-inf, 0) → (0, 0.5)
      // Double it and clamp to get (0, 1) range.
      const rawRank = hit.rank; // negative
      const normalizedScore = Math.min(1, Math.max(0, 2 / (1 + Math.exp(rawRank))));

      const existing = candidateScores.get(hit.id);
      if (existing) {
        existing.fts = normalizedScore;
      } else {
        candidateScores.set(hit.id, { vector: 0, fts: normalizedScore });
      }
    }
  }
} catch {
  // FTS may be unavailable
}
```

#### Step 4.4: Run test to verify it passes

Run: `npx vitest run src/__tests__/graph-search.test.ts -t "FTS score normalization"`
Expected: PASS — scores are now meaningful (> 0.1).

#### Step 4.5: Run full test suite

Run: `npx vitest run`
Expected: All tests PASS.

#### Step 4.6: Commit

```bash
git add src/host/graph-search.ts src/__tests__/graph-search.test.ts
git commit -m "feat(2.4): FTS score normalization — sigmoid transform for meaningful scores with small doc sets"
```

---

### Task 5: Search Result Cache

**Files:**
- Modify: `src/host/graph-search.ts` — add LRU cache
- Modify: `src/__tests__/graph-search.test.ts` — add cache tests

#### Step 5.1: Write the failing test

Add to `src/__tests__/graph-search.test.ts`:

```typescript
describe("search cache", () => {
  it("returns cached results on repeated query", () => {
    engine.upsertEntity({ name: "Cached", type: "concept", summary: "test cache" });

    const opts = { minScore: 0, vectorWeight: 0, ftsWeight: 1, graphWeight: 0 };
    const results1 = searchGraph(db, engine, "Cached", opts);
    const results2 = searchGraph(db, engine, "Cached", opts);

    // Same results
    expect(results2.length).toBe(results1.length);
    if (results1.length > 0 && results2.length > 0) {
      expect(results2[0]!.entity.id).toBe(results1[0]!.entity.id);
    }
  });

  it("cache can be cleared", () => {
    engine.upsertEntity({ name: "Fresh", type: "concept", summary: "clear cache" });

    searchGraph(db, engine, "Fresh", { minScore: 0 });
    clearSearchCache();

    // After clear, search still works (just recomputes)
    const results = searchGraph(db, engine, "Fresh", { minScore: 0 });
    expect(results.length).toBeGreaterThan(0);
  });

  it("cache respects TTL", async () => {
    engine.upsertEntity({ name: "TTL", type: "concept", summary: "ttl test" });

    // Search with short TTL cache
    const results1 = searchGraph(db, engine, "TTL", { minScore: 0, cacheTtlMs: 50 });

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 60));

    // Modify the entity
    engine.upsertEntity({ name: "TTL", type: "concept", summary: "updated" });

    // Should get fresh results (cache expired)
    const results2 = searchGraph(db, engine, "TTL", { minScore: 0, cacheTtlMs: 50 });
    expect(results2.length).toBeGreaterThan(0);
  });
});
```

#### Step 5.2: Run test to verify it fails

Run: `npx vitest run src/__tests__/graph-search.test.ts -t "search cache"`
Expected: FAIL — `clearSearchCache` is not exported.

#### Step 5.3: Implement LRU cache

Add at the top of `src/host/graph-search.ts`:

```typescript
// ---------------------------------------------------------------------------
// Search result cache (LRU with TTL)
// ---------------------------------------------------------------------------

type CacheEntry = {
  results: GraphSearchResult[];
  timestamp: number;
};

const searchCache = new Map<string, CacheEntry>();
const DEFAULT_CACHE_MAX = 128;
const DEFAULT_CACHE_TTL_MS = 30_000; // 30 seconds

function makeCacheKey(query: string, opts?: GraphSearchOpts): string {
  // Hash the query + relevant options
  const parts = [
    query,
    opts?.maxResults ?? 10,
    opts?.minScore ?? 0.1,
    opts?.types?.join(",") ?? "",
    opts?.activeOnly ?? true,
    opts?.vectorWeight ?? 0.5,
    opts?.ftsWeight ?? 0.3,
    opts?.graphWeight ?? 0.2,
    opts?.temporalDecayDays ?? 30,
  ];
  return parts.join("\x00");
}

function cacheGet(key: string, ttlMs: number): GraphSearchResult[] | null {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ttlMs) {
    searchCache.delete(key);
    return null;
  }
  return entry.results;
}

function cacheSet(key: string, results: GraphSearchResult[]): void {
  // Evict oldest if at capacity
  if (searchCache.size >= DEFAULT_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) searchCache.delete(oldest);
  }
  searchCache.set(key, { results, timestamp: Date.now() });
}

/** Clear the search result cache. Call after writes that change entity data. */
export function clearSearchCache(): void {
  searchCache.clear();
}
```

#### Step 5.4: Wire cache into `searchGraph`

Add `cacheTtlMs` to `GraphSearchOpts`:

```typescript
export type GraphSearchOpts = {
  // ... existing fields ...
  /** Cache TTL in ms. 0 = no cache. Default 30000 (30s). */
  cacheTtlMs?: number;
};
```

At the start of `searchGraph`, add cache lookup:

```typescript
export function searchGraph(
  db: DatabaseSync,
  engine: MemoryGraphEngine,
  query: string,
  opts?: GraphSearchOpts,
): GraphSearchResult[] {
  const cacheTtlMs = opts?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  // Check cache
  if (cacheTtlMs > 0) {
    const cacheKey = makeCacheKey(query, opts);
    const cached = cacheGet(cacheKey, cacheTtlMs);
    if (cached) return cached;
  }

  // ... existing search logic ...

  // Before return, cache the results
  const finalResults = applyDiversityFilter(results, maxResults);
  if (cacheTtlMs > 0) {
    const cacheKey = makeCacheKey(query, opts);
    cacheSet(cacheKey, finalResults);
  }
  return finalResults;
}
```

#### Step 5.5: Auto-invalidate cache on writes

In `graph-engine.ts`, after `upsertEntity` and `invalidateEntity`, call `clearSearchCache()`:

```typescript
import { clearSearchCache } from "./graph-search.js";

// In upsertEntity, after syncEntityFts:
clearSearchCache();

// In invalidateEntity, after removeEntityFts:
clearSearchCache();
```

#### Step 5.6: Export `clearSearchCache`

Add to `src/index.ts`:

```typescript
export {
  searchGraph,
  clearSearchCache,
  type GraphSearchOpts,
  type GraphSearchResult,
} from "./host/graph-search.js";
```

#### Step 5.7: Run test to verify it passes

Run: `npx vitest run src/__tests__/graph-search.test.ts -t "search cache"`
Expected: PASS

#### Step 5.8: Run full test suite

Run: `npx vitest run`
Expected: All tests PASS.

#### Step 5.9: Commit

```bash
git add src/host/graph-search.ts src/host/graph-engine.ts src/index.ts src/__tests__/graph-search.test.ts
git commit -m "feat(2.5): search result cache — LRU with TTL, auto-invalidation on writes"
```

---

### Task 6: Final Integration & Version Bump

**Files:**
- Modify: `package.json` — bump to 0.4.0, add sqlite-vec as optional peer dep
- Modify: `CHANGELOG.md` — add v0.4.0 section
- Modify: `ROADMAP.md` — mark Phase 2 as complete
- Modify: `src/host/graph-schema.ts` — update return type for vec info
- Modify: `src/index.ts` — export vec functions

#### Step 6.1: Update `package.json`

```json
{
  "version": "0.4.0",
  "peerDependencies": {
    "sqlite-vec": ">=0.1.0"
  },
  "peerDependenciesMeta": {
    "sqlite-vec": {
      "optional": true
    }
  }
}
```

#### Step 6.2: Update `CHANGELOG.md`

Add at the top:

```markdown
## [0.4.0] - 2026-04-28

### Added
- **sqlite-vec ANN index**: Optional approximate nearest neighbor search via `vec0` virtual table. Falls back to current full-scan when sqlite-vec is not installed. Entities auto-synced to vec index on write.
- **Incremental embedding updates**: `embedFn` only called when entity name or summary changes (tracked via `content_hash` column). Saves expensive API calls on no-op updates.
- **Batch operations**: `upsertEntities()` and `addEdges()` for multi-item operations in a single transaction. New `memoryBatchStore` agent tool.
- **FTS score normalization**: Sigmoid transform replaces relative-to-best normalization. Scores are now meaningful (0.1–1.0 range) even with small document sets.
- **Search result cache**: LRU cache (128 entries, 30s TTL) for `searchGraph`. Auto-invalidated on entity writes. Configurable per-query via `cacheTtlMs`.
```

#### Step 6.3: Update `ROADMAP.md`

Mark Phase 2 items as complete:

```markdown
## ✅ Phase 2 (v0.4) — 性能与搜索优化

| # | 特性 | 说明 | 对标竞品 |
|---|------|------|---------|
| 2.1 | sqlite-vec ANN 索引 | ... | ... |
| 2.2 | 增量 embedding 更新 | ... | ... |
| 2.3 | 批量操作 API | ... | ... |
| 2.4 | FTS 评分归一化 | ... | ... |
| 2.5 | 搜索结果缓存 | ... | ... |
```

#### Step 6.4: Run full test suite

Run: `npx vitest run`
Expected: All tests PASS.

#### Step 6.5: Build

Run: `npm run build && npm run typecheck`
Expected: No errors.

#### Step 6.6: Commit

```bash
git add package.json CHANGELOG.md ROADMAP.md
git commit -m "chore(v0.4): bump version, update changelog and roadmap"
```

---

## Execution Notes

**sqlite-vec availability in tests:** Tests that depend on sqlite-vec should use early-return guards (`if (!available) return;`) so the full suite passes regardless of whether sqlite-vec is installed. CI can optionally install sqlite-vec for full ANN coverage.

**Import order:** `graph-vec.ts` imports from `graph-engine.ts` (for `deserializeEmbedding`). `graph-engine.ts` imports from `graph-vec.ts` (for `vecUpsert`/`vecRemove`). This is a circular dependency — resolve by making vec calls dynamic (lazy import) or by moving `deserializeEmbedding` to a shared utils file.

**Recommended resolution:** Move `serializeEmbedding` and `deserializeEmbedding` to a new `src/host/graph-utils.ts`, import from there in both `graph-engine.ts` and `graph-vec.ts`.

**Cache invalidation strategy:** The current design invalidates on any entity write. For high-throughput scenarios, consider a write-coalescing approach (invalidate at end of transaction). The `runInTransaction` wrapper makes this straightforward — add `clearSearchCache()` only in the outermost transaction commit.
