import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import { ensureGraphSchema } from "../host/graph-schema.js";
import { createTestDb } from "./test-helpers.js";
import {
  createBackup,
  createIncrementalBackup,
  writeBackup,
  readBackup,
  restoreBackup,
  type BackupData,
} from "../host/graph-backup.js";

describe("backup and restore", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });
  afterEach(() => db.close());

  function populateGraph() {
    const a = engine.upsertEntity({ name: "Alice", type: "user", summary: "developer" });
    const b = engine.upsertEntity({ name: "React", type: "concept", summary: "UI library" });
    engine.addEdge({ fromId: a.id, toId: b.id, relation: "uses" });
    engine.recordEpisode({ sessionKey: "s1", content: "Alice likes React" });
    return { a, b };
  }

  describe("createBackup", () => {
    it("exports all graph data", () => {
      populateGraph();
      const backup = createBackup(engine);

      expect(backup.manifest.entityCount).toBe(2);
      expect(backup.manifest.edgeCount).toBe(1);
      expect(backup.manifest.episodeCount).toBe(1);
      expect(backup.entities.length).toBe(2);
      expect(backup.edges.length).toBe(1);
      expect(backup.episodes.length).toBe(1);
    });

    it("produces valid JSON-serializable data", () => {
      populateGraph();
      const backup = createBackup(engine);
      const json = JSON.stringify(backup);
      const parsed = JSON.parse(json);
      expect(parsed.manifest.entityCount).toBe(2);
    });

    it("exports empty graph correctly", () => {
      const backup = createBackup(engine);
      expect(backup.manifest.entityCount).toBe(0);
      expect(backup.manifest.edgeCount).toBe(0);
      expect(backup.manifest.episodeCount).toBe(0);
    });

    it("includes all entity fields", () => {
      populateGraph();
      const backup = createBackup(engine);
      const entity = backup.entities[0]!;
      expect(entity.id).toBeDefined();
      expect(entity.name).toBeDefined();
      expect(entity.type).toBeDefined();
      expect(entity.created_at).toBeGreaterThan(0);
      expect(entity.valid_from).toBeGreaterThan(0);
    });
  });

  describe("createIncrementalBackup", () => {
    it("exports only records modified after timestamp", () => {
      // Insert data with explicit timestamps via direct SQL
      const pastTime = 1000;
      const futureTime = 2000;
      db.prepare(
        `INSERT INTO entities (id, name, type, summary, confidence, source, valid_from, created_at, updated_at, access_count, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("e1", "Alice", "user", "developer", 1.0, "manual", pastTime, pastTime, pastTime, 0, 0);
      db.prepare(
        `INSERT INTO entities (id, name, type, summary, confidence, source, valid_from, created_at, updated_at, access_count, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("e2", "Vue", "concept", null, 1.0, "manual", futureTime, futureTime, futureTime, 0, 0);

      const backup = createIncrementalBackup(engine, pastTime);
      expect(backup.manifest.sinceTimestamp).toBe(pastTime);
      expect(backup.entities.length).toBe(1);
      expect(backup.entities[0]!.name).toBe("Vue");
    });

    it("exports only edges created after timestamp", () => {
      const pastTime = 1000;
      const futureTime = 2000;
      db.prepare(
        `INSERT INTO entities (id, name, type, confidence, source, valid_from, created_at, updated_at, access_count, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("e1", "Alice", "user", 1.0, "manual", pastTime, pastTime, pastTime, 0, 0);
      db.prepare(
        `INSERT INTO entities (id, name, type, confidence, source, valid_from, created_at, updated_at, access_count, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("e2", "React", "concept", 1.0, "manual", pastTime, pastTime, pastTime, 0, 0);
      db.prepare(
        `INSERT INTO edges (id, from_id, to_id, relation, weight, valid_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("ed1", "e1", "e2", "uses", 1.0, pastTime, pastTime);
      db.prepare(
        `INSERT INTO edges (id, from_id, to_id, relation, weight, valid_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("ed2", "e1", "e2", "likes", 1.0, futureTime, futureTime);

      const backup = createIncrementalBackup(engine, pastTime);
      expect(backup.edges.length).toBe(1);
      expect(backup.edges[0]!.relation).toBe("likes");
    });

    it("exports only episodes after timestamp", () => {
      const pastTime = 1000;
      const futureTime = 2000;
      db.prepare(
        `INSERT INTO episodes (id, session_key, content, timestamp) VALUES (?, ?, ?, ?)`,
      ).run("ep1", "s1", "old episode", pastTime);
      db.prepare(
        `INSERT INTO episodes (id, session_key, content, timestamp) VALUES (?, ?, ?, ?)`,
      ).run("ep2", "s2", "new episode", futureTime);

      const backup = createIncrementalBackup(engine, pastTime);
      expect(backup.episodes.length).toBe(1);
      expect(backup.episodes[0]!.session_key).toBe("s2");
    });

    it("returns empty when nothing new", () => {
      populateGraph();
      const futureTime = Date.now() + 10_000;
      const backup = createIncrementalBackup(engine, futureTime);
      expect(backup.entities.length).toBe(0);
      expect(backup.edges.length).toBe(0);
      expect(backup.episodes.length).toBe(0);
    });
  });

  describe("writeBackup / readBackup", () => {
    const tmpDir = path.join(process.env.TMPDIR ?? "/tmp", "openclaw-backup-test");

    beforeEach(async () => {
      await fs.mkdir(tmpDir, { recursive: true });
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("round-trips through JSON file", async () => {
      populateGraph();
      const backup = createBackup(engine);
      const filePath = path.join(tmpDir, "backup.json");

      const writeResult = await writeBackup(backup, filePath);
      expect(writeResult.path).toBe(filePath);
      expect(writeResult.entityCount).toBe(2);
      expect(writeResult.incremental).toBe(false);

      const restored = await readBackup(filePath);
      expect(restored.manifest.entityCount).toBe(2);
      expect(restored.entities.length).toBe(2);
      expect(restored.edges.length).toBe(1);
    });

    it("marks incremental backups correctly", async () => {
      engine.upsertEntity({ name: "Test", type: "concept" });
      const midTime = Date.now() + 1;
      engine.upsertEntity({ name: "Test2", type: "concept" });
      const backup = createIncrementalBackup(engine, midTime);
      const filePath = path.join(tmpDir, "incr-backup.json");

      const result = await writeBackup(backup, filePath);
      expect(result.incremental).toBe(true);
    });
  });

  describe("restoreBackup", () => {
    it("restores entities and edges into a fresh database", () => {
      populateGraph();
      const backup = createBackup(engine);

      const db2 = new DatabaseSync(":memory:", { allowExtension: true });
      ensureGraphSchema({ db: db2, ftsEnabled: true });
      const engine2 = new MemoryGraphEngine(db2);

      const result = restoreBackup(engine2, backup);
      expect(result.entitiesRestored).toBe(2);
      expect(result.edgesRestored).toBe(1);
      expect(result.episodesRestored).toBe(1);
      expect(result.errors).toHaveLength(0);

      const entities = engine2.findEntities({});
      expect(entities.length).toBe(2);

      db2.close();
    });

    it("skips duplicates by default", () => {
      populateGraph();
      const backup = createBackup(engine);

      const result = restoreBackup(engine, backup);
      expect(result.skipped).toBe(4); // 2 entities + 1 edge + 1 episode
      expect(result.entitiesRestored).toBe(0);
      expect(result.edgesRestored).toBe(0);
      expect(result.episodesRestored).toBe(0);
    });

    it("overwrites entities when overwrite=true", () => {
      populateGraph();
      const backup = createBackup(engine);

      // Modify an entity
      engine.upsertEntity({ name: "Alice", type: "user", summary: "modified" });

      const result = restoreBackup(engine, backup, { overwrite: true });
      expect(result.entitiesRestored).toBe(2);
      // Edge and episode still skipped (overwrite only applies to entities/edges, not episodes)
      expect(result.skipped).toBe(1); // episode only
    });

    it("supports point-in-time restore", () => {
      const pastTime = 1000;
      const futureTime = 2000;
      // Insert entities with explicit timestamps
      db.prepare(
        `INSERT INTO entities (id, name, type, confidence, source, valid_from, created_at, updated_at, access_count, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("e1", "Alice", "user", 1.0, "manual", pastTime, pastTime, pastTime, 0, 0);
      db.prepare(
        `INSERT INTO entities (id, name, type, confidence, source, valid_from, created_at, updated_at, access_count, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("e2", "React", "concept", 1.0, "manual", pastTime, pastTime, pastTime, 0, 0);
      db.prepare(
        `INSERT INTO entities (id, name, type, confidence, source, valid_from, created_at, updated_at, access_count, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("e3", "Late", "concept", 1.0, "manual", futureTime, futureTime, futureTime, 0, 0);

      const backup = createBackup(engine);

      const db2 = new DatabaseSync(":memory:", { allowExtension: true });
      ensureGraphSchema({ db: db2, ftsEnabled: true });
      const engine2 = new MemoryGraphEngine(db2);

      // Restore to pastTime — "Late" (created_at=2000) should be skipped
      const result = restoreBackup(engine2, backup, { pointInTime: pastTime });
      expect(result.skipped).toBe(1);
      expect(result.entitiesRestored).toBe(2);

      db2.close();
    });

    it("handles empty backup", () => {
      const emptyBackup: BackupData = {
        manifest: { version: "1.0", createdAt: Date.now(), entityCount: 0, edgeCount: 0, episodeCount: 0 },
        entities: [],
        edges: [],
        episodes: [],
      };

      const result = restoreBackup(engine, emptyBackup);
      expect(result.entitiesRestored).toBe(0);
      expect(result.edgesRestored).toBe(0);
      expect(result.episodesRestored).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it("round-trip: backup then restore preserves data", () => {
      populateGraph();
      const backup = createBackup(engine);

      const db2 = new DatabaseSync(":memory:", { allowExtension: true });
      ensureGraphSchema({ db: db2, ftsEnabled: true });
      const engine2 = new MemoryGraphEngine(db2);

      restoreBackup(engine2, backup);

      const s1 = engine.stats();
      const s2 = engine2.stats();
      expect(s2.entities).toBe(s1.entities);
      expect(s2.edges).toBe(s1.edges);
      expect(s2.episodes).toBe(s1.episodes);

      db2.close();
    });
  });
});
