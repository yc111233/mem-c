/**
 * Backup and restore for the memory graph.
 * Export/import as JSON with incremental and point-in-time support.
 */

import fs from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import type { EntityRow, EdgeRow, EpisodeRow } from "./graph-schema.js";
import type { MemoryGraphEngine } from "./graph-engine.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackupManifest = {
  version: string;
  createdAt: number;
  entityCount: number;
  edgeCount: number;
  episodeCount: number;
  /** If incremental, the timestamp of the previous backup. */
  sinceTimestamp?: number;
};

export type BackupData = {
  manifest: BackupManifest;
  entities: EntityRow[];
  edges: EdgeRow[];
  episodes: EpisodeRow[];
};

export type BackupResult = {
  path: string;
  entityCount: number;
  edgeCount: number;
  episodeCount: number;
  incremental: boolean;
};

export type RestoreOpts = {
  /** Restore only entities/edges valid at this timestamp. Omit for full restore. */
  pointInTime?: number;
  /** Overwrite existing entities with same ID. Default false (skip duplicates). */
  overwrite?: boolean;
};

export type RestoreResult = {
  entitiesRestored: number;
  edgesRestored: number;
  episodesRestored: number;
  skipped: number;
  errors: string[];
};

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/**
 * Create a full backup of the graph data.
 */
export function createBackup(engine: MemoryGraphEngine): BackupData {
  const db = engine.getDb();
  const now = Date.now();

  const entities = db
    .prepare(`SELECT * FROM entities`)
    .all() as EntityRow[];
  const edges = db
    .prepare(`SELECT * FROM edges`)
    .all() as EdgeRow[];
  const episodes = db
    .prepare(`SELECT * FROM episodes`)
    .all() as EpisodeRow[];

  return {
    manifest: {
      version: "1.0",
      createdAt: now,
      entityCount: entities.length,
      edgeCount: edges.length,
      episodeCount: episodes.length,
    },
    entities,
    edges,
    episodes,
  };
}

/**
 * Create an incremental backup — only records modified since the given timestamp.
 */
export function createIncrementalBackup(
  engine: MemoryGraphEngine,
  sinceTimestamp: number,
): BackupData {
  const db = engine.getDb();
  const now = Date.now();

  const entities = db
    .prepare(`SELECT * FROM entities WHERE updated_at > ?`)
    .all(sinceTimestamp) as EntityRow[];
  const edges = db
    .prepare(`SELECT * FROM edges WHERE created_at > ?`)
    .all(sinceTimestamp) as EdgeRow[];
  const episodes = db
    .prepare(`SELECT * FROM episodes WHERE timestamp > ?`)
    .all(sinceTimestamp) as EpisodeRow[];

  return {
    manifest: {
      version: "1.0",
      createdAt: now,
      entityCount: entities.length,
      edgeCount: edges.length,
      episodeCount: episodes.length,
      sinceTimestamp,
    },
    entities,
    edges,
    episodes,
  };
}

/**
 * Write backup data to a JSON file.
 */
export async function writeBackup(
  data: BackupData,
  filePath: string,
): Promise<BackupResult> {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  return {
    path: filePath,
    entityCount: data.entities.length,
    edgeCount: data.edges.length,
    episodeCount: data.episodes.length,
    incremental: !!data.manifest.sinceTimestamp,
  };
}

/**
 * Read backup data from a JSON file.
 */
export async function readBackup(filePath: string): Promise<BackupData> {
  const content = await fs.readFile(filePath, "utf-8");
  return JSON.parse(content) as BackupData;
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Restore graph data from a backup.
 */
export function restoreBackup(
  engine: MemoryGraphEngine,
  data: BackupData,
  opts?: RestoreOpts,
): RestoreResult {
  const db = engine.getDb();
  const result: RestoreResult = {
    entitiesRestored: 0,
    edgesRestored: 0,
    episodesRestored: 0,
    skipped: 0,
    errors: [],
  };

  const pointInTime = opts?.pointInTime;
  const overwrite = opts?.overwrite ?? false;

  engine.runInTransaction(() => {
    // Restore entities
    for (const entity of data.entities) {
      try {
        // Point-in-time filter: skip entities not yet valid at the target time
        if (pointInTime && entity.created_at > pointInTime) {
          result.skipped++;
          continue;
        }

        // Check if entity already exists
        const existing = db
          .prepare(`SELECT id FROM entities WHERE id = ?`)
          .get(entity.id) as { id: string } | undefined;

        if (existing && !overwrite) {
          result.skipped++;
          continue;
        }

        if (existing && overwrite) {
          db.prepare(
            `UPDATE entities SET name = ?, type = ?, summary = ?, embedding = ?, confidence = ?, source = ?, valid_from = ?, valid_until = ?, created_at = ?, updated_at = ?, access_count = ?, last_accessed_at = ?, content_hash = ?, namespace = ? WHERE id = ?`,
          ).run(
            entity.name, entity.type, entity.summary, entity.embedding,
            entity.confidence, entity.source, entity.valid_from, entity.valid_until,
            entity.created_at, entity.updated_at, entity.access_count ?? 0,
            entity.last_accessed_at ?? 0, entity.content_hash ?? null,
            entity.namespace ?? null, entity.id,
          );
        } else {
          db.prepare(
            `INSERT INTO entities (id, name, type, summary, embedding, confidence, source, valid_from, valid_until, created_at, updated_at, access_count, last_accessed_at, content_hash, namespace) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            entity.id, entity.name, entity.type, entity.summary, entity.embedding,
            entity.confidence, entity.source, entity.valid_from, entity.valid_until,
            entity.created_at, entity.updated_at, entity.access_count ?? 0,
            entity.last_accessed_at ?? 0, entity.content_hash ?? null,
            entity.namespace ?? null,
          );
        }
        result.entitiesRestored++;
      } catch (err) {
        result.errors.push(
          `entity ${entity.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Restore edges
    for (const edge of data.edges) {
      try {
        if (pointInTime && edge.created_at > pointInTime) {
          result.skipped++;
          continue;
        }

        const existing = db
          .prepare(`SELECT id FROM edges WHERE id = ?`)
          .get(edge.id) as { id: string } | undefined;

        if (existing && !overwrite) {
          result.skipped++;
          continue;
        }

        if (existing && overwrite) {
          db.prepare(
            `UPDATE edges SET from_id = ?, to_id = ?, relation = ?, weight = ?, metadata = ?, valid_from = ?, valid_until = ?, created_at = ?, namespace = ? WHERE id = ?`,
          ).run(
            edge.from_id, edge.to_id, edge.relation, edge.weight, edge.metadata,
            edge.valid_from, edge.valid_until, edge.created_at,
            edge.namespace ?? null, edge.id,
          );
        } else {
          db.prepare(
            `INSERT INTO edges (id, from_id, to_id, relation, weight, metadata, valid_from, valid_until, created_at, namespace) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            edge.id, edge.from_id, edge.to_id, edge.relation, edge.weight,
            edge.metadata, edge.valid_from, edge.valid_until, edge.created_at,
            edge.namespace ?? null,
          );
        }
        result.edgesRestored++;
      } catch (err) {
        result.errors.push(
          `edge ${edge.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Restore episodes
    for (const episode of data.episodes) {
      try {
        if (pointInTime && episode.timestamp > pointInTime) {
          result.skipped++;
          continue;
        }

        const existing = db
          .prepare(`SELECT id FROM episodes WHERE id = ?`)
          .get(episode.id) as { id: string } | undefined;

        if (existing) {
          result.skipped++;
          continue;
        }

        db.prepare(
          `INSERT INTO episodes (id, session_key, turn_index, content, extracted_entity_ids, timestamp, namespace) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          episode.id, episode.session_key, episode.turn_index, episode.content,
          episode.extracted_entity_ids, episode.timestamp,
          episode.namespace ?? null,
        );
        result.episodesRestored++;
      } catch (err) {
        result.errors.push(
          `episode ${episode.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  });

  return result;
}
