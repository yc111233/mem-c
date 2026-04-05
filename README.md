# openclaw-memory

Temporal knowledge graph memory system for AI agents — SQLite-based, zero-infrastructure, with hybrid retrieval (vector + FTS + graph traversal).

## Features

- **Temporal Knowledge Graph** — Entities, edges, and episodes with full time tracking (valid_from/valid_until)
- **Hybrid Search** — Vector similarity + FTS5 + graph connectivity scoring with temporal decay
- **Tiered Context Loading** — L0 (~200 tokens) → L1 (~800 tokens) → L2 (~2000 tokens)
- **Auto Extraction** — LLM-driven entity and relationship extraction from conversation transcripts
- **Markdown Migration** — Import existing MEMORY.md / memory/*.md files into the graph
- **Zero Infrastructure** — SQLite with FTS5, no external services required

## Install

```bash
npm install openclaw-memory
```

## Quick Start

```typescript
import { DatabaseSync } from "node:sqlite";
import { ensureGraphSchema, MemoryGraphEngine } from "openclaw-memory";

const db = new DatabaseSync(":memory:");
ensureGraphSchema({ db });
const engine = new MemoryGraphEngine(db);
engine.upsertEntity({ name: "user", type: "user", summary: "A user" });
```

## Entity Types

user · project · concept · file · decision · feedback · tool · preference · (custom)

## Context Tiers

- **L0** (~200 tokens): Entity roster for system prompt
- **L1** (~800 tokens): Search results with summaries + relations
- **L2** (~2000 tokens): Full entity detail + edges + episodes

## License

MIT
