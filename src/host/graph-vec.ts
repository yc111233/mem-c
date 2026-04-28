import type { DatabaseSync } from "node:sqlite";

/**
 * Inline deserialization of BLOB embeddings (Float32Array ↔ Buffer).
 * Avoids circular dependency with graph-engine.ts.
 */
function deserializeEmbeddingInline(blob: Buffer): number[] {
  const f32 = new Float32Array(new Uint8Array(blob).buffer);
  return Array.from(f32);
}

/**
 * Ensure the sqlite-vec virtual table exists for ANN indexing.
 * Returns availability status — non-fatal if vec0 extension is missing.
 */
export function ensureVecIndex(
  db: DatabaseSync,
  dimensions: number,
): { available: boolean; error?: string } {
  try {
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
      `INSERT OR REPLACE INTO entities_vec (id, embedding) VALUES (?, vec(?))`,
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
        `SELECT id, distance FROM entities_vec WHERE embedding MATCH vec(?) ORDER BY distance LIMIT k`,
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
      `INSERT OR REPLACE INTO entities_vec (id, embedding) VALUES (?, vec(?))`,
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
