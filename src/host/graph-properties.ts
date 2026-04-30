import type { DatabaseSync } from "node:sqlite";
import type { EntityPropertyRow } from "./graph-schema.js";
import { randomUUID } from "node:crypto";

export type PropertyInput = {
  key: string;
  value: string;
  valueType?: "string" | "number" | "boolean" | "date";
  confidence?: number;
  sourceUnitId?: string;
};

export function setEntityProperty(
  db: DatabaseSync,
  entityId: string,
  input: PropertyInput,
  namespace: string | null,
): EntityPropertyRow {
  const now = Date.now();
  const id = randomUUID();

  // Invalidate old property with same key
  db.prepare(
    `UPDATE entity_properties SET valid_until = ?, updated_at = ? WHERE entity_id = ? AND key = ? AND valid_until IS NULL AND (namespace = ? OR (namespace IS NULL AND ? IS NULL))`,
  ).run(now, now, entityId, input.key, namespace, namespace);

  // Insert new
  db.prepare(
    `INSERT INTO entity_properties (id, entity_id, key, value, value_type, confidence, source_unit_id, valid_from, valid_until, created_at, updated_at, namespace) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  ).run(
    id,
    entityId,
    input.key,
    input.value,
    input.valueType ?? "string",
    input.confidence ?? 1.0,
    input.sourceUnitId ?? null,
    now,
    now,
    now,
    namespace,
  );

  return db
    .prepare(`SELECT * FROM entity_properties WHERE id = ?`)
    .get(id) as EntityPropertyRow;
}

export function getEntityProperties(
  db: DatabaseSync,
  entityId: string,
  opts?: {
    activeOnly?: boolean;
    key?: string;
    namespace?: string | null;
  },
): EntityPropertyRow[] {
  const conditions = [`entity_id = ?`];
  const params: (string | null)[] = [entityId];

  if (opts?.activeOnly ?? true) {
    conditions.push(`valid_until IS NULL`);
  }
  if (opts?.key) {
    conditions.push(`key = ?`);
    params.push(opts.key);
  }
  if (opts?.namespace !== undefined) {
    if (opts.namespace === null) {
      conditions.push(`namespace IS NULL`);
    } else {
      conditions.push(`namespace = ?`);
      params.push(opts.namespace);
    }
  }

  return db
    .prepare(
      `SELECT * FROM entity_properties WHERE ${conditions.join(" AND ")} ORDER BY key, updated_at DESC`,
    )
    .all(...params) as EntityPropertyRow[];
}

export function getEffectiveProperties(
  db: DatabaseSync,
  entityId: string,
  namespace: string | null,
): Record<string, { value: string; type: string; confidence: number }> {
  const props = getEntityProperties(db, entityId, {
    activeOnly: true,
    namespace,
  });
  const result: Record<
    string,
    { value: string; type: string; confidence: number }
  > = {};
  for (const p of props) {
    // Keep highest confidence per key
    if (!result[p.key] || p.confidence > result[p.key]!.confidence) {
      result[p.key] = {
        value: p.value,
        type: p.value_type,
        confidence: p.confidence,
      };
    }
  }
  return result;
}

export function deleteEntityProperty(
  db: DatabaseSync,
  entityId: string,
  key: string,
  namespace: string | null,
): void {
  const now = Date.now();
  db.prepare(
    `UPDATE entity_properties SET valid_until = ?, updated_at = ? WHERE entity_id = ? AND key = ? AND valid_until IS NULL AND (namespace = ? OR (namespace IS NULL AND ? IS NULL))`,
  ).run(now, now, entityId, key, namespace, namespace);
}
