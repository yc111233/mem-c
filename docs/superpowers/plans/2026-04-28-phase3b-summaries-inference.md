# Phase 3b (v0.5.1) — Community Summaries & Relation Type Inference

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add LLM-powered community summaries (store in `communities.label`) and relation type inference (suggest richer relation types for existing edges).

**Architecture:** Both features use the existing callback injection pattern — the library provides prompts and schemas, the caller provides an LLM function. `summarizeCommunities` takes a `SummarizeFn` callback, iterates communities, and stores results. `inferRelationTypes` takes an `InferRelationFn` callback, analyzes entity pairs with generic relations, and suggests richer types.

**Tech Stack:** Pure TypeScript + existing LLM callback pattern (same as `LlmExtractFn`)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/host/graph-community.ts` | Modify | Add `summarizeCommunities`, `SummarizeFn`, prompt |
| `src/host/graph-inference.ts` | **Create** | Relation type inference logic |
| `src/host/graph-tools.ts` | Modify | Add `memorySummarizeCommunities`, `memoryInferRelations` tools |
| `src/index.ts` | Modify | Export new functions and types |
| `src/__tests__/graph-community.test.ts` | Modify | Add summarize tests |
| `src/__tests__/graph-inference.test.ts` | **Create** | Inference tests |

---

### Task 1: Community Summaries

**Files:**
- Modify: `src/host/graph-community.ts` — add `SummarizeFn`, prompt, `summarizeCommunities`
- Modify: `src/__tests__/graph-community.test.ts` — add summary tests

- [ ] **Step 1: Write failing tests**

Add to `src/__tests__/graph-community.test.ts`:

```typescript
describe("summarizeCommunities", () => {
  it("calls summarizeFn for each community and stores label", async () => {
    const a = engine.upsertEntity({ name: "React", type: "concept", summary: "UI library" });
    const b = engine.upsertEntity({ name: "Vue", type: "concept", summary: "Progressive framework" });
    engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

    detectCommunities(engine);

    const mockSummarize = async () => "Frontend frameworks";
    const result = await summarizeCommunities(engine, mockSummarize);

    expect(result.summarized).toBe(1);

    const communities = getCommunities(engine);
    expect(communities[0]!.label).toBe("Frontend frameworks");
  });

  it("handles multiple communities", async () => {
    const a = engine.upsertEntity({ name: "A", type: "concept" });
    const b = engine.upsertEntity({ name: "B", type: "concept" });
    engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

    const c = engine.upsertEntity({ name: "C", type: "concept" });
    const d = engine.upsertEntity({ name: "D", type: "concept" });
    engine.addEdge({ fromId: c.id, toId: d.id, relation: "relates" });

    detectCommunities(engine);

    let callCount = 0;
    const mockSummarize = async () => {
      callCount++;
      return `Summary ${callCount}`;
    };

    const result = await summarizeCommunities(engine, mockSummarize);
    expect(result.summarized).toBe(2);
  });

  it("skips summarizeFn errors gracefully", async () => {
    const a = engine.upsertEntity({ name: "A", type: "concept" });
    const b = engine.upsertEntity({ name: "B", type: "concept" });
    engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates" });

    detectCommunities(engine);

    const mockSummarize = async () => {
      throw new Error("LLM unavailable");
    };

    const result = await summarizeCommunities(engine, mockSummarize);
    expect(result.summarized).toBe(0);
    expect(result.errors.length).toBe(1);
  });

  it("returns 0 when no communities exist", async () => {
    const mockSummarize = async () => "test";
    const result = await summarizeCommunities(engine, mockSummarize);
    expect(result.summarized).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/graph-community.test.ts -t "summarizeCommunities"`
Expected: FAIL — `summarizeCommunities` is not exported.

- [ ] **Step 3: Add SummarizeFn type and prompt**

Add to `src/host/graph-community.ts` (after the existing types):

```typescript
/**
 * Callback type for LLM community summarization.
 * Receives entity names/types/summaries and edge relations for one community.
 * Returns a concise label/summary for the community.
 */
export type SummarizeFn = (params: {
  entities: Array<{ name: string; type: string; summary: string | null }>;
  relations: Array<{ from: string; to: string; relation: string }>;
}) => Promise<string>;

export const COMMUNITY_SUMMARY_PROMPT = `You are analyzing a cluster of related entities in a knowledge graph. Generate a concise label (2-5 words) that describes what this community is about.

Input: a list of entities with their types and summaries, and the relationships between them.

Rules:
- Return ONLY the label text, no explanation.
- Be specific, not generic. "Frontend frameworks" is better than "Technology".
- If there's no clear theme, use the most prominent entity name.`;
```

- [ ] **Step 4: Implement summarizeCommunities**

Add to `src/host/graph-community.ts`:

```typescript
/**
 * Run an LLM summarize function on each community to generate labels.
 * Stores results in the communities table.
 */
export async function summarizeCommunities(
  engine: MemoryGraphEngine,
  summarizeFn: SummarizeFn,
): Promise<{ summarized: number; errors: string[] }> {
  const communities = getCommunities(engine);
  const db = engine.getDb();
  const updateLabel = db.prepare(`UPDATE communities SET label = ?, updated_at = ? WHERE id = ?`);
  const now = Date.now();

  let summarized = 0;
  const errors: string[] = [];

  for (const community of communities) {
    try {
      // Build context for the LLM
      const entities = community.entityIds
        .map((id) => engine.getEntity(id))
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .map((e) => ({ name: e.name, type: e.type, summary: e.summary }));

      // Get edges between community members
      const memberSet = new Set(community.entityIds);
      const relations: Array<{ from: string; to: string; relation: string }> = [];
      const seenEdges = new Set<string>();

      for (const entityId of community.entityIds) {
        const edges = engine.findEdges({ entityId, activeOnly: true, limit: 50 });
        for (const edge of edges) {
          if (memberSet.has(edge.from_id) && memberSet.has(edge.to_id) && !seenEdges.has(edge.id)) {
            seenEdges.add(edge.id);
            const fromEntity = engine.getEntity(edge.from_id);
            const toEntity = engine.getEntity(edge.to_id);
            relations.push({
              from: fromEntity?.name ?? edge.from_id.slice(0, 8),
              to: toEntity?.name ?? edge.to_id.slice(0, 8),
              relation: edge.relation,
            });
          }
        }
      }

      const label = await summarizeFn({ entities, relations });
      updateLabel.run(label, now, community.id);
      summarized++;
    } catch (err) {
      errors.push(
        `community ${community.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { summarized, errors };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/graph-community.test.ts -t "summarizeCommunities"`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/host/graph-community.ts src/__tests__/graph-community.test.ts
git commit -m "feat(3.2): community summaries via LLM callback"
```

---

### Task 2: Relation Type Inference

**Files:**
- Create: `src/host/graph-inference.ts`
- Create: `src/__tests__/graph-inference.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/graph-inference.test.ts`:

```typescript
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import {
  inferRelationTypes,
  type InferRelationFn,
  type InferenceSuggestion,
} from "../host/graph-inference.js";
import { createTestDb } from "./test-helpers.js";

describe("relation type inference", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  describe("inferRelationTypes", () => {
    it("calls inferFn for each generic-relation edge and returns suggestions", async () => {
      const a = engine.upsertEntity({ name: "Alice", type: "user", summary: "developer" });
      const b = engine.upsertEntity({ name: "React", type: "concept", summary: "UI library" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates_to" });

      const mockInfer: InferRelationFn = async (params) => {
        return { relation: "uses", confidence: 0.9, reason: "Developer uses framework" };
      };

      const result = await inferRelationTypes(engine, mockInfer);

      expect(result.suggestions.length).toBe(1);
      expect(result.suggestions[0]!.suggestedRelation).toBe("uses");
      expect(result.suggestions[0]!.confidence).toBe(0.9);
      expect(result.analyzed).toBe(1);
    });

    it("skips edges with specific relation types", async () => {
      const a = engine.upsertEntity({ name: "Alice", type: "user" });
      const b = engine.upsertEntity({ name: "React", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "works_on" });

      const mockInfer: InferRelationFn = async () => ({ relation: "uses", confidence: 0.9 });

      const result = await inferRelationTypes(engine, mockInfer);
      expect(result.analyzed).toBe(0); // works_on is specific, not generic
    });

    it("respects targetRelations option to filter which edges to analyze", async () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "custom_generic" });

      const mockInfer: InferRelationFn = async () => ({ relation: "specific", confidence: 0.8 });

      // Only analyze "custom_generic" relations
      const result = await inferRelationTypes(engine, mockInfer, {
        targetRelations: ["custom_generic"],
      });
      expect(result.analyzed).toBe(1);
    });

    it("handles inferFn errors gracefully", async () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates_to" });

      const mockInfer: InferRelationFn = async () => {
        throw new Error("LLM error");
      };

      const result = await inferRelationTypes(engine, mockInfer);
      expect(result.suggestions.length).toBe(0);
      expect(result.errors.length).toBe(1);
    });

    it("returns empty when no edges match", async () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      engine.addEdge({ fromId: a.id, toId: b.id, relation: "works_on" });

      const mockInfer: InferRelationFn = async () => ({ relation: "x", confidence: 0.5 });

      const result = await inferRelationTypes(engine, mockInfer);
      expect(result.analyzed).toBe(0);
      expect(result.suggestions.length).toBe(0);
    });

    it("applySuggestions updates edge relations", async () => {
      const a = engine.upsertEntity({ name: "A", type: "concept" });
      const b = engine.upsertEntity({ name: "B", type: "concept" });
      const edge = engine.addEdge({ fromId: a.id, toId: b.id, relation: "relates_to" });

      const mockInfer: InferRelationFn = async () => ({ relation: "depends_on", confidence: 0.85 });

      const result = await inferRelationTypes(engine, mockInfer);

      // Apply the suggestion
      result.applySuggestions(engine);

      const edges = engine.findEdges({ entityId: a.id });
      expect(edges.length).toBe(1);
      expect(edges[0]!.relation).toBe("depends_on");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/graph-inference.test.ts`
Expected: FAIL — `graph-inference.js` does not exist.

- [ ] **Step 3: Implement graph-inference.ts**

Create `src/host/graph-inference.ts`:

```typescript
/**
 * Relation type inference: suggest richer relation types for generic edges.
 * Uses LLM callback to analyze entity pairs and suggest more specific relations.
 */

import type { MemoryGraphEngine, Edge } from "./graph-engine.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Callback type for LLM relation inference.
 * Receives two entities and their current relation.
 * Returns a suggested relation type, confidence, and optional reason.
 */
export type InferRelationFn = (params: {
  fromName: string;
  fromType: string;
  fromSummary: string | null;
  toName: string;
  toType: string;
  toSummary: string | null;
  currentRelation: string;
}) => Promise<{ relation: string; confidence: number; reason?: string }>;

export type InferenceSuggestion = {
  edgeId: string;
  fromName: string;
  toName: string;
  currentRelation: string;
  suggestedRelation: string;
  confidence: number;
  reason?: string;
};

export type InferenceResult = {
  analyzed: number;
  suggestions: InferenceSuggestion[];
  errors: string[];
  /** Apply all suggestions to the graph (update edge relations). */
  applySuggestions: (engine: MemoryGraphEngine) => void;
};

export type InferenceOpts = {
  /** Only analyze edges with these relation types. Default: generic types. */
  targetRelations?: string[];
  /** Max edges to analyze. Default 50. */
  maxEdges?: number;
  /** Min confidence to include in suggestions. Default 0.5. */
  minConfidence?: number;
};

/** Relation types considered "generic" — candidates for inference. */
const DEFAULT_GENERIC_RELATIONS = [
  "relates_to",
  "related",
  "connects",
  "associated",
  "linked",
  "generic",
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Analyze edges with generic relation types and suggest richer alternatives.
 * Does not modify the graph — call applySuggestions() on the result to apply.
 */
export async function inferRelationTypes(
  engine: MemoryGraphEngine,
  inferFn: InferRelationFn,
  opts?: InferenceOpts,
): Promise<InferenceResult> {
  const targetRelations = opts?.targetRelations ?? DEFAULT_GENERIC_RELATIONS;
  const maxEdges = opts?.maxEdges ?? 50;
  const minConfidence = opts?.minConfidence ?? 0.5;

  const db = engine.getDb();
  const targetSet = new Set(targetRelations);

  // Find edges with generic relations
  const allEdges = db
    .prepare(
      `SELECT * FROM edges WHERE valid_until IS NULL ORDER BY created_at DESC LIMIT ?`,
    )
    .all(maxEdges * 2) as Array<Edge>;

  const candidateEdges = allEdges
    .filter((e) => targetSet.has(e.relation))
    .slice(0, maxEdges);

  const suggestions: InferenceSuggestion[] = [];
  const errors: string[] = [];

  for (const edge of candidateEdges) {
    try {
      const fromEntity = engine.getEntity(edge.from_id);
      const toEntity = engine.getEntity(edge.to_id);
      if (!fromEntity || !toEntity) continue;

      const result = await inferFn({
        fromName: fromEntity.name,
        fromType: fromEntity.type,
        fromSummary: fromEntity.summary,
        toName: toEntity.name,
        toType: toEntity.type,
        toSummary: toEntity.summary,
        currentRelation: edge.relation,
      });

      if (
        result.relation !== edge.relation &&
        result.confidence >= minConfidence &&
        result.relation.trim().length > 0
      ) {
        suggestions.push({
          edgeId: edge.id,
          fromName: fromEntity.name,
          toName: toEntity.name,
          currentRelation: edge.relation,
          suggestedRelation: result.relation,
          confidence: result.confidence,
          reason: result.reason,
        });
      }
    } catch (err) {
      errors.push(
        `edge ${edge.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const applySuggestions = (engine: MemoryGraphEngine) => {
    engine.runInTransaction(() => {
      for (const suggestion of suggestions) {
        const db = engine.getDb();
        db.prepare(
          `UPDATE edges SET relation = ?, metadata = COALESCE(?, metadata) WHERE id = ?`,
        ).run(
          suggestion.suggestedRelation,
          JSON.stringify({
            inferredFrom: suggestion.currentRelation,
            confidence: suggestion.confidence,
            reason: suggestion.reason,
          }),
          suggestion.edgeId,
        );
      }
    });
  };

  return {
    analyzed: candidateEdges.length,
    suggestions,
    errors,
    applySuggestions,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/graph-inference.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/host/graph-inference.ts src/__tests__/graph-inference.test.ts
git commit -m "feat(3.4): relation type inference via LLM callback"
```

---

### Task 3: Agent Tools & Exports

**Files:**
- Modify: `src/host/graph-tools.ts` — add 2 new tools
- Modify: `src/index.ts` — export new modules

- [ ] **Step 1: Add imports to graph-tools.ts**

Add at top:

```typescript
import { summarizeCommunities, type SummarizeFn } from "./graph-community.js";
import { inferRelationTypes, type InferRelationFn } from "./graph-inference.js";
```

- [ ] **Step 2: Add memorySummarizeCommunities tool**

Add at the end of `src/host/graph-tools.ts`:

```typescript
// ---------------------------------------------------------------------------
// Tool: memory_summarize_communities
// ---------------------------------------------------------------------------

export type MemorySummarizeCommunitiesInput = {
  summarizeFn: SummarizeFn;
};

export type MemorySummarizeCommunitiesOutput = {
  summarized: number;
  errors: string[];
};

export async function memorySummarizeCommunities(
  engine: MemoryGraphEngine,
  input: MemorySummarizeCommunitiesInput,
): Promise<MemorySummarizeCommunitiesOutput> {
  return summarizeCommunities(engine, input.summarizeFn);
}
```

- [ ] **Step 3: Add memoryInferRelations tool**

```typescript
// ---------------------------------------------------------------------------
// Tool: memory_infer_relations
// ---------------------------------------------------------------------------

export type MemoryInferRelationsInput = {
  inferFn: InferRelationFn;
  targetRelations?: string[];
  maxEdges?: number;
  autoApply?: boolean;
};

export type MemoryInferRelationsOutput = {
  analyzed: number;
  suggestions: Array<{
    fromName: string;
    toName: string;
    currentRelation: string;
    suggestedRelation: string;
    confidence: number;
    reason?: string;
  }>;
  applied: boolean;
  errors: string[];
};

export async function memoryInferRelations(
  engine: MemoryGraphEngine,
  input: MemoryInferRelationsInput,
): Promise<MemoryInferRelationsOutput> {
  const result = await inferRelationTypes(engine, input.inferFn, {
    targetRelations: input.targetRelations,
    maxEdges: input.maxEdges,
  });

  if (input.autoApply && result.suggestions.length > 0) {
    result.applySuggestions(engine);
  }

  return {
    analyzed: result.analyzed,
    suggestions: result.suggestions.map((s) => ({
      fromName: s.fromName,
      toName: s.toName,
      currentRelation: s.currentRelation,
      suggestedRelation: s.suggestedRelation,
      confidence: s.confidence,
      reason: s.reason,
    })),
    applied: input.autoApply ?? false,
    errors: result.errors,
  };
}
```

- [ ] **Step 4: Export from index.ts**

Add to `src/index.ts`:

```typescript
// Relation inference
export {
  inferRelationTypes,
  type InferRelationFn,
  type InferenceSuggestion,
  type InferenceResult,
  type InferenceOpts,
} from "./host/graph-inference.js";
```

Add `SummarizeFn` to the existing graph-community exports.
Add `COMMUNITY_SUMMARY_PROMPT` to the graph-community exports.

Add to graph-tools exports:

```typescript
memorySummarizeCommunities,
memoryInferRelations,
type MemorySummarizeCommunitiesInput,
type MemorySummarizeCommunitiesOutput,
type MemoryInferRelationsInput,
type MemoryInferRelationsOutput,
```

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run && npm run typecheck`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add src/host/graph-tools.ts src/index.ts
git commit -m "feat(3.x): add summarize and inference agent tools + exports"
```

---

### Task 4: Integration & Version Bump

**Files:**
- Modify: `package.json` — bump to 0.5.1
- Modify: `CHANGELOG.md`
- Modify: `ROADMAP.md` — mark 3.2, 3.4 as done

- [ ] **Step 1: Update CHANGELOG.md**

Add at top:

```markdown
## [0.5.1] - 2026-04-28

### Added
- **Community summaries**: `summarizeCommunities()` runs an LLM callback on each detected community to generate labels. Stored in `communities.label`. Prompt template `COMMUNITY_SUMMARY_PROMPT` provided.
- **Relation type inference**: `inferRelationTypes()` analyzes edges with generic relation types (e.g., `relates_to`) and suggests richer alternatives via LLM callback. `applySuggestions()` updates edges with inferred types and metadata.
- **New agent tools**: `memorySummarizeCommunities`, `memoryInferRelations`.
```

- [ ] **Step 2: Update ROADMAP.md**

Mark items 3.2 and 3.4 as done in the Phase 3a section (or create a Phase 3b section).

- [ ] **Step 3: Bump version**

In `package.json`, change `"version": "0.5.0"` to `"version": "0.5.1"`.

- [ ] **Step 4: Run and commit**

```bash
npx vitest run && npm run typecheck
git add package.json CHANGELOG.md ROADMAP.md
git commit -m "chore(v0.5.1): bump version, mark Phase 3b complete"
```

---

## Self-Review

**Spec coverage:**
- 3.2 Community summaries → Task 1 ✅
- 3.4 Relation type inference → Task 2 ✅
- Agent tools → Task 3 ✅
- Version/docs → Task 4 ✅

**Placeholder scan:** No TBD/TODO. All code blocks complete.

**Type consistency:**
- `SummarizeFn` defined in graph-community.ts, imported in graph-tools.ts ✅
- `InferRelationFn` defined in graph-inference.ts, imported in graph-tools.ts ✅
- `InferenceSuggestion` has `edgeId`, `fromName`, `toName` — matches tool output type ✅
- `applySuggestions` takes `MemoryGraphEngine` — same as used in tools ✅

**Design note:** `inferRelationTypes` does NOT apply changes by default — it returns suggestions + an `applySuggestions` function. This follows the principle of progressive enhancement and gives the caller control. The `memoryInferRelations` tool adds an `autoApply` flag for convenience.
