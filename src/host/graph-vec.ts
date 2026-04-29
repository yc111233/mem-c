import type { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";

/**
 * Inline deserialization of BLOB embeddings (Float32Array ↔ Buffer).
 * Avoids circular dependency with graph-engine.ts.
 */
function deserializeEmbeddingInline(blob: Buffer): number[] {
  const f32 = new Float32Array(new Uint8Array(blob).buffer);
  return Array.from(f32);
}

/**
 * Find the sqlite-vec extension dylib/so path from node_modules.
 * Returns null if not installed.
 */
function findVecExtensionPath(): string | null {
  const platform = process.platform;
  const arch = process.arch;
  const osName = platform === "win32" ? "windows" : platform;
  const suffix = platform === "win32" ? "dll" : platform === "darwin" ? "dylib" : "so";
  const pkgName = `sqlite-vec-${osName}-${arch}`;
  const fileName = `vec0.${suffix}`;

  // Try to resolve from the module's own location (works when cwd differs from package root)
  const selfDir = dirname(new URL(import.meta.url).pathname);

  for (const baseDir of [selfDir, process.cwd()]) {
    try {
      const require = createRequire(join(baseDir, "noop.js"));
      const pkgDir = dirname(require.resolve(`${pkgName}/package.json`));
      const fullPath = join(pkgDir, fileName);
      if (existsSync(fullPath)) return fullPath;
    } catch {
      // Try next
    }

    // Direct path fallback
    const candidate = join(baseDir, "node_modules", pkgName, fileName);
    if (existsSync(candidate)) return candidate;

    // Walk up to find project root's node_modules
    let dir = baseDir;
    for (let i = 0; i < 5; i++) {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
      const walkCandidate = join(dir, "node_modules", pkgName, fileName);
      if (existsSync(walkCandidate)) return walkCandidate;
    }
  }

  return null;
}

/**
 * Ensure the sqlite-vec virtual table exists for ANN indexing.
 * Loads the sqlite-vec extension if available, then creates the vec0 table.
 * Returns availability status — non-fatal if vec0 extension is missing.
 */
export function ensureVecIndex(
  db: DatabaseSync,
  dimensions: number,
): { available: boolean; error?: string } {
  try {
    // Try to load sqlite-vec extension
    const extPath = findVecExtensionPath();
    if (extPath) {
      // Enable extension loading (requires allowExtension: true at DB creation)
      try {
        (db as any).enableLoadExtension(true);
        (db as any).loadExtension(extPath);
      } catch {
        // Extension loading may be disabled — try without (vec0 may already be loaded)
      }
    }

    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS entities_vec USING vec0(id TEXT, embedding FLOAT[${dimensions}])`,
    );
    return { available: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { available: false, error: message };
  }
}

/**
 * Insert or update a vector in the ANN index. No-op if vec is not available.
 */
export function vecUpsert(
  db: DatabaseSync,
  entityId: string,
  embedding: number[],
  available: boolean,
): void {
  if (!available) return;
  try {
    db.prepare(
      `INSERT OR REPLACE INTO entities_vec (id, embedding) VALUES (?, vec_f32(?))`,
    ).run(entityId, JSON.stringify(embedding));
  } catch {
    // Non-fatal: vec index is best-effort
  }
}

/**
 * Remove a vector from the ANN index. No-op if vec is not available.
 */
export function vecRemove(
  db: DatabaseSync,
  entityId: string,
  available: boolean,
): void {
  if (!available) return;
  try {
    db.prepare(`DELETE FROM entities_vec WHERE id = ?`).run(entityId);
  } catch {
    // Non-fatal
  }
}

/**
 * Query the ANN index for k nearest neighbors.
 * Returns sorted by distance (ascending). Returns empty if not available.
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
        `SELECT id, distance FROM entities_vec WHERE embedding MATCH vec_f32(?) ORDER BY distance LIMIT ?`,
      )
      .all(JSON.stringify(queryEmbedding), k) as Array<{ id: string; distance: number }>;
    return rows;
  } catch {
    return [];
  }
}

/**
 * Sync all entities with embeddings into the vec index.
 * Used for initial migration / rebuild after schema init.
 */
export function vecSyncAll(db: DatabaseSync, available: boolean): number {
  if (!available) return 0;
  let count = 0;
  try {
    const rows = db
      .prepare(`SELECT id, embedding FROM entities WHERE embedding IS NOT NULL`)
      .all() as Array<{ id: string; embedding: Buffer }>;

    const stmt = db.prepare(
      `INSERT OR REPLACE INTO entities_vec (id, embedding) VALUES (?, vec_f32(?))`,
    );

    for (const row of rows) {
      try {
        const vec = deserializeEmbeddingInline(row.embedding);
        stmt.run(row.id, JSON.stringify(vec));
        count++;
      } catch {
        // Skip corrupted embeddings
      }
    }
  } catch {
    // Non-fatal
  }
  return count;
}
