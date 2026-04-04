import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import { migrateMarkdownMemory } from "../host/graph-migrate.js";
import { ensureGraphSchema } from "../host/graph-schema.js";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureGraphSchema({ db, ftsEnabled: true });
  return db;
}

describe("graph-migrate", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;
  let tmpDir: string;

  beforeEach(async () => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "graph-migrate-test-"));
  });

  afterEach(async () => {
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("migrates memory files with frontmatter", async () => {
    const memoryDir = path.join(tmpDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    await fs.writeFile(
      path.join(memoryDir, "user_role.md"),
      `---
name: User Role
description: Senior TypeScript developer
type: user
---

The user is a senior TypeScript developer working on OpenClaw.
`,
    );

    await fs.writeFile(
      path.join(memoryDir, "feedback_testing.md"),
      `---
name: Testing Preferences
description: Prefers integration tests over mocks
type: feedback
---

Use real databases in tests, not mocks.
`,
    );

    const result = await migrateMarkdownMemory({
      engine,
      workspaceDir: tmpDir,
    });

    expect(result.filesProcessed).toBe(2);
    expect(result.entitiesCreated).toBe(2);
    expect(result.errors).toHaveLength(0);

    const userEntities = engine.findEntities({ type: "user" });
    expect(userEntities).toHaveLength(1);
    expect(userEntities[0]!.name).toBe("User Role");
    expect(userEntities[0]!.summary).toBe("Senior TypeScript developer");

    const feedbackEntities = engine.findEntities({ type: "feedback" });
    expect(feedbackEntities).toHaveLength(1);
  });

  it("handles files without frontmatter", async () => {
    const memoryDir = path.join(tmpDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    await fs.writeFile(
      path.join(memoryDir, "notes.md"),
      "Important: always run tests before pushing.\n",
    );

    const result = await migrateMarkdownMemory({
      engine,
      workspaceDir: tmpDir,
    });

    expect(result.filesProcessed).toBe(1);
    expect(result.entitiesCreated).toBe(1);

    const entities = engine.findEntities({ name: "notes" });
    expect(entities).toHaveLength(1);
    expect(entities[0]!.summary).toBe("Important: always run tests before pushing.");
  });

  it("does not duplicate on re-run", async () => {
    const memoryDir = path.join(tmpDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    await fs.writeFile(
      path.join(memoryDir, "test.md"),
      `---
name: Test Memory
description: A test
type: project
---
Content here.
`,
    );

    await migrateMarkdownMemory({ engine, workspaceDir: tmpDir });
    const secondResult = await migrateMarkdownMemory({ engine, workspaceDir: tmpDir });

    expect(secondResult.entitiesUpdated).toBe(1);
    expect(secondResult.entitiesCreated).toBe(0);

    // Should still be just one entity
    const entities = engine.findEntities({ name: "Test Memory" });
    expect(entities).toHaveLength(1);
  });

  it("handles missing memory directory gracefully", async () => {
    const result = await migrateMarkdownMemory({
      engine,
      workspaceDir: tmpDir,
    });

    expect(result.filesProcessed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});
