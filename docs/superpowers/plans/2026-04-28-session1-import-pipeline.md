# Session 1: Knowledge Import Pipeline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Build a document import pipeline that reads any document, chunks it intelligently, extracts entities/relations via LLM, and merges into the graph — with cross-chunk deduplication.

**Architecture:** `importDocument` is the unified entry point. It accepts a `DocumentParser` (pluggable), a `SmartChunker` (semantic boundary-aware), and reuses the existing `extractAndMerge` for LLM extraction. Cross-chunk dedup is free — `upsertEntity` already merges by name+type.

**Tech Stack:** Pure TypeScript + existing `extractAndMerge` from graph-extractor.ts

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/host/graph-import.ts` | **Create** | `importDocument` API + `DocumentParser` type + `SmartChunker` |
| `src/host/graph-parsers.ts` | **Create** | Markdown parser implementation |
| `src/__tests__/graph-import.test.ts` | **Create** | Import pipeline tests |
| `src/__tests__/graph-parsers.test.ts` | **Create** | Parser tests |

---

### Task 1: Smart Chunker

**Files:**
- Create: `src/host/graph-import.ts` (chunker types + implementation)

- [ ] **Step 1: Define types and chunker**

```typescript
/**
 * Document import pipeline: parse → chunk → extract → merge.
 */

import type { MemoryGraphEngine } from "./graph-engine.js";
import type { LlmExtractFn } from "./graph-extractor.js";
import { extractAndMerge } from "./graph-extractor.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DocumentChunk = {
  /** Chunk index (0-based). */
  index: number;
  /** Text content of this chunk. */
  content: string;
  /** Optional section heading this chunk belongs to. */
  heading?: string;
  /** Heading level (1-6) if applicable. */
  headingLevel?: number;
};

export type DocumentParser = (content: string) => DocumentChunk[];

export type ImportOpts = {
  /** Document content as string. */
  content: string;
  /** Parser to convert content into chunks. */
  parser: DocumentParser;
  /** LLM extraction callback. */
  llmExtract: LlmExtractFn;
  /** Session key for episode tracking. */
  sessionKey?: string;
  /** Max tokens per chunk (approximate, 4 chars/token). Default 2000. */
  chunkSize?: number;
};

export type ImportResult = {
  chunksProcessed: number;
  entitiesCreated: number;
  entitiesUpdated: number;
  edgesCreated: number;
  errors: string[];
};

// ---------------------------------------------------------------------------
// Smart Chunker
// ---------------------------------------------------------------------------

/**
 * Split text into chunks respecting semantic boundaries.
 * Tries to split on paragraph breaks first, then sentences, then hard cut.
 */
export function smartChunk(
  text: string,
  maxChunkChars: number = 8000, // ~2000 tokens
): string[] {
  if (text.length <= maxChunkChars) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChunkChars) {
      chunks.push(remaining);
      break;
    }

    // Find the best split point within maxChunkChars
    const window = remaining.slice(0, maxChunkChars);
    let splitIdx = -1;

    // Priority 1: double newline (paragraph break)
    const paraBreak = window.lastIndexOf("\n\n");
    if (paraBreak > maxChunkChars * 0.3) {
      splitIdx = paraBreak + 2;
    }

    // Priority 2: single newline
    if (splitIdx < 0) {
      const lineBreak = window.lastIndexOf("\n");
      if (lineBreak > maxChunkChars * 0.3) {
        splitIdx = lineBreak + 1;
      }
    }

    // Priority 3: sentence end (. ! ?)
    if (splitIdx < 0) {
      const sentenceEnd = window.search(/[.!?]\s+(?=[A-Z一-鿿])/);
      if (sentenceEnd > 0 && sentenceEnd > maxChunkChars * 0.3) {
        splitIdx = sentenceEnd + 1;
      }
    }

    // Priority 4: hard cut
    if (splitIdx < 0) {
      splitIdx = maxChunkChars;
    }

    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks.filter((c) => c.length > 0);
}
```

- [ ] **Step 2: Write tests for smartChunk**

Create `src/__tests__/graph-import.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { smartChunk } from "../host/graph-import.js";

describe("smartChunk", () => {
  it("returns single chunk for short text", () => {
    const chunks = smartChunk("Hello world", 1000);
    expect(chunks).toEqual(["Hello world"]);
  });

  it("splits on paragraph break", () => {
    const text = "First paragraph content here.\n\nSecond paragraph content here.";
    const chunks = smartChunk(text, 30);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toContain("First");
    expect(chunks[1]).toContain("Second");
  });

  it("splits on sentence boundary", () => {
    const text = "This is sentence one. This is sentence two. This is sentence three.";
    const chunks = smartChunk(text, 35);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should end at a sentence boundary
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk).toMatch(/[.!?]$/);
    }
  });

  it("hard cuts when no good boundary", () => {
    const text = "a".repeat(200);
    const chunks = smartChunk(text, 50);
    expect(chunks.length).toBe(4);
  });

  it("preserves all content", () => {
    const text = "Paragraph one.\n\nParagraph two.\n\nParagraph three.";
    const chunks = smartChunk(text, 20);
    const reconstructed = chunks.join(" ");
    expect(reconstructed).toContain("Paragraph one");
    expect(reconstructed).toContain("Paragraph two");
    expect(reconstructed).toContain("Paragraph three");
  });
});
```

- [ ] **Step 3: Run and commit**

```bash
npx vitest run
git add src/host/graph-import.ts src/__tests__/graph-import.test.ts
git commit -m "feat(5b): smart chunker with semantic boundary detection"
```

---

### Task 2: importDocument API

**Files:**
- Modify: `src/host/graph-import.ts` — add `importDocument` function

- [ ] **Step 1: Implement importDocument**

Add to `src/host/graph-import.ts`:

```typescript
/**
 * Import a document into the memory graph.
 * Pipeline: parse → chunk → extract (per chunk) → merge.
 * Cross-chunk dedup is automatic via upsertEntity's name+type matching.
 */
export async function importDocument(
  engine: MemoryGraphEngine,
  opts: ImportOpts,
): Promise<ImportResult> {
  const result: ImportResult = {
    chunksProcessed: 0,
    entitiesCreated: 0,
    entitiesUpdated: 0,
    edgesCreated: 0,
    errors: [],
  };

  const maxChunkChars = (opts.chunkSize ?? 2000) * 4; // ~4 chars per token
  const sessionKey = opts.sessionKey ?? `import-${Date.now()}`;

  // Step 1: Parse document into raw chunks
  const parsedChunks = opts.parser(opts.content);

  // Step 2: Apply smart chunking to each parsed chunk
  const allChunks: DocumentChunk[] = [];
  for (const chunk of parsedChunks) {
    const subChunks = smartChunk(chunk.content, maxChunkChars);
    for (let i = 0; i < subChunks.length; i++) {
      allChunks.push({
        index: allChunks.length,
        content: subChunks[i]!,
        heading: chunk.heading,
        headingLevel: chunk.headingLevel,
      });
    }
  }

  if (allChunks.length === 0) return result;

  // Step 3: Extract and merge per chunk
  // Collect existing entity names for cross-chunk dedup hints
  const existingNames = engine.getActiveEntities().map((e) => e.name);

  for (const chunk of allChunks) {
    try {
      // Prepend heading context if available
      const contextualContent = chunk.heading
        ? `[Section: ${chunk.heading}]\n${chunk.content}`
        : chunk.content;

      const extractResult = await extractAndMerge({
        engine,
        transcript: contextualContent,
        sessionKey,
        turnIndex: chunk.index,
        llmExtract: opts.llmExtract,
        existingEntityNames: existingNames,
      });

      result.chunksProcessed++;
      result.entitiesCreated += extractResult.entitiesCreated;
      result.entitiesUpdated += extractResult.entitiesUpdated;
      result.edgesCreated += extractResult.edgesCreated;

      // Update existing names for next chunk's dedup hints
      for (const err of extractResult.errors) {
        result.errors.push(`chunk ${chunk.index}: ${err}`);
      }
    } catch (err) {
      result.errors.push(
        `chunk ${chunk.index}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}
```

- [ ] **Step 2: Write tests**

Add to `src/__tests__/graph-import.test.ts`:

```typescript
import { DatabaseSync } from "node:sqlite";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import { importDocument, type DocumentParser } from "../host/graph-import.js";
import { ensureGraphSchema } from "../host/graph-schema.js";
import { createTestDb } from "./test-helpers.js";

describe("importDocument", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  it("processes a simple document", async () => {
    // Mock LLM that returns a simple entity
    const mockExtract = async () =>
      JSON.stringify({
        entities: [{ name: "TestEntity", type: "concept", summary: "from doc", confidence: 0.9 }],
        relations: [],
        invalidations: [],
      });

    const parser: DocumentParser = (content) => [{ index: 0, content }];

    const result = await importDocument(engine, {
      content: "This is a test document about TestEntity.",
      parser,
      llmExtract: mockExtract,
    });

    expect(result.chunksProcessed).toBe(1);
    expect(result.entitiesCreated).toBeGreaterThanOrEqual(1);
  });

  it("handles multiple chunks with cross-chunk dedup", async () => {
    let callCount = 0;
    const mockExtract = async () => {
      callCount++;
      return JSON.stringify({
        entities: [{ name: "SharedEntity", type: "concept", summary: `chunk ${callCount}`, confidence: 0.9 }],
        relations: [],
        invalidations: [],
      });
    };

    // Parser that produces 2 chunks
    const parser: DocumentParser = (content) => {
      const mid = Math.floor(content.length / 2);
      return [
        { index: 0, content: content.slice(0, mid) },
        { index: 1, content: content.slice(mid) },
      ];
    };

    const result = await importDocument(engine, {
      content: "A".repeat(200) + "\n\n" + "B".repeat(200),
      parser,
      llmExtract: mockExtract,
      chunkSize: 50, // small chunks to force splitting
    });

    // Entity should be created once, then updated (not duplicated)
    const entities = engine.findEntities({ name: "SharedEntity" });
    expect(entities.length).toBe(1);
  });

  it("returns empty result for empty content", async () => {
    const mockExtract = async () =>
      JSON.stringify({ entities: [], relations: [], invalidations: [] });
    const parser: DocumentParser = () => [];

    const result = await importDocument(engine, {
      content: "",
      parser,
      llmExtract: mockExtract,
    });

    expect(result.chunksProcessed).toBe(0);
  });
});
```

- [ ] **Step 3: Run and commit**

```bash
npx vitest run
git add src/host/graph-import.ts src/__tests__/graph-import.test.ts
git commit -m "feat(5b.1): importDocument API — unified document import pipeline"
```

---

### Task 3: Markdown Parser

**Files:**
- Create: `src/host/graph-parsers.ts`
- Create: `src/__tests__/graph-parsers.test.ts`

- [ ] **Step 1: Implement markdown parser**

```typescript
/**
 * Document parsers for various formats.
 * Each parser converts raw content into DocumentChunk[].
 */

import type { DocumentChunk } from "./graph-import.js";

// ---------------------------------------------------------------------------
// Markdown Parser
// ---------------------------------------------------------------------------

/**
 * Parse markdown content into chunks based on heading structure.
 * Each heading (## / ### / etc.) starts a new chunk.
 * Content under each heading becomes one chunk.
 */
export function markdownParser(content: string): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  const lines = content.split("\n");

  let currentHeading: string | undefined;
  let currentLevel: number | undefined;
  let currentContent: string[] = [];

  const flush = () => {
    const text = currentContent.join("\n").trim();
    if (text.length > 0) {
      chunks.push({
        index: chunks.length,
        content: text,
        heading: currentHeading,
        headingLevel: currentLevel,
      });
    }
    currentContent = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      // New heading — flush previous chunk
      flush();
      currentLevel = headingMatch[1]!.length;
      currentHeading = headingMatch[2]!.trim();
    } else {
      currentContent.push(line);
    }
  }

  // Flush remaining content
  flush();

  return chunks;
}

/**
 * Simple text parser — treats the entire content as a single chunk.
 * Useful for plain text documents.
 */
export function textParser(content: string): DocumentChunk[] {
  return [{ index: 0, content }];
}
```

- [ ] **Step 2: Write tests**

```typescript
import { describe, expect, it } from "vitest";
import { markdownParser, textParser } from "../host/graph-parsers.js";

describe("markdownParser", () => {
  it("splits on headings", () => {
    const md = `# Title

Some intro text.

## Section 1

Content of section 1.

## Section 2

Content of section 2.`;

    const chunks = markdownParser(md);
    expect(chunks.length).toBe(3);
    expect(chunks[0]!.heading).toBeUndefined(); // before first heading
    expect(chunks[1]!.heading).toBe("Section 1");
    expect(chunks[2]!.heading).toBe("Section 2");
  });

  it("preserves heading levels", () => {
    const md = `## H2

Content.

### H3

Sub-content.`;

    const chunks = markdownParser(md);
    expect(chunks[0]!.headingLevel).toBe(2);
    expect(chunks[1]!.headingLevel).toBe(3);
  });

  it("handles document with no headings", () => {
    const md = "Just plain text with no headings.";
    const chunks = markdownParser(md);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.content).toBe(md);
  });

  it("skips empty sections", () => {
    const md = `## Empty Section

## Non-empty Section

Has content.`;

    const chunks = markdownParser(md);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.heading).toBe("Non-empty Section");
  });

  it("assigns sequential indices", () => {
    const md = `## A\n\nContent.\n\n## B\n\nMore.`;
    const chunks = markdownParser(md);
    expect(chunks[0]!.index).toBe(0);
    expect(chunks[1]!.index).toBe(1);
  });
});

describe("textParser", () => {
  it("returns single chunk", () => {
    const chunks = textParser("Hello world");
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.content).toBe("Hello world");
  });
});
```

- [ ] **Step 3: Run and commit**

```bash
npx vitest run
git add src/host/graph-parsers.ts src/__tests__/graph-parsers.test.ts
git commit -m "feat(5b.2): markdown parser — heading-based document chunking"
```

---

### Task 4: Export & Integration

**Files:**
- Modify: `src/index.ts` — export new modules

- [ ] **Step 1: Export from index.ts**

Add to `src/index.ts`:

```typescript
// Document import pipeline
export {
  importDocument,
  smartChunk,
  type DocumentChunk,
  type DocumentParser,
  type ImportOpts,
  type ImportResult,
} from "./host/graph-import.js";

// Parsers
export {
  markdownParser,
  textParser,
} from "./host/graph-parsers.js";
```

- [ ] **Step 2: Run and commit**

```bash
npx vitest run && npm run typecheck
git add src/index.ts
git commit -m "feat(5b.x): export import pipeline + parsers"
```

---

### Task 5: Version Bump

- [ ] **Step 1: Update CHANGELOG, bump to 0.7.0, commit**

```bash
git add package.json CHANGELOG.md ROADMAP.md
git commit -m "chore(v0.7): bump version, add import pipeline to changelog"
```
