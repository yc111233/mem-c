/**
 * Append-only provenance layer for the memory graph.
 *
 * Records text units, fact assertions, and supersession proposals.
 * The extractor never directly destroys history — it only appends facts
 * and evidence, then proposes supersession when contradictions are found.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  EpisodeTextUnitRow,
  FactAssertionRow,
  SupersessionProposalRow,
} from "./graph-schema.js";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export type TextUnitInput = {
  episodeId: string;
  content: string;
  turnIndex?: number;
  speaker?: string;
  startOffset?: number;
  endOffset?: number;
};

export type AssertionInput = {
  entityId: string;
  assertionText: string;
  confidence?: number;
  sourceUnitId?: string;
};

export type SupersessionProposalInput = {
  targetEntityId: string;
  targetAssertionId?: string;
  newAssertionText: string;
  reason?: string;
  evidenceUnitId?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nsCol(namespace: string | null): { clause: string; params: (string | null)[] } {
  if (namespace !== null) {
    return { clause: "namespace = ?", params: [namespace] };
  }
  return { clause: "namespace IS NULL", params: [] };
}

// ---------------------------------------------------------------------------
// recordTextUnit
// ---------------------------------------------------------------------------

export function recordTextUnit(
  db: DatabaseSync,
  input: TextUnitInput,
  opts?: { namespace?: string | null },
): EpisodeTextUnitRow {
  const id = randomUUID();
  const now = Date.now();
  const namespace = opts?.namespace ?? null;

  db.prepare(
    `INSERT INTO episode_text_units (id, episode_id, turn_index, speaker, content, start_offset, end_offset, created_at, namespace) ` +
      `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.episodeId,
    input.turnIndex ?? null,
    input.speaker ?? null,
    input.content,
    input.startOffset ?? null,
    input.endOffset ?? null,
    now,
    namespace,
  );

  return db.prepare(`SELECT * FROM episode_text_units WHERE id = ?`).get(id) as EpisodeTextUnitRow;
}

// ---------------------------------------------------------------------------
// recordAssertion
// ---------------------------------------------------------------------------

export function recordAssertion(
  db: DatabaseSync,
  input: AssertionInput,
  opts?: { namespace?: string | null },
): FactAssertionRow {
  const id = randomUUID();
  const now = Date.now();
  const namespace = opts?.namespace ?? null;

  db.prepare(
    `INSERT INTO fact_assertions (id, entity_id, assertion_text, confidence, status, source_unit_id, created_at, updated_at, namespace) ` +
      `VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
  ).run(
    id,
    input.entityId,
    input.assertionText,
    input.confidence ?? 1.0,
    input.sourceUnitId ?? null,
    now,
    now,
    namespace,
  );

  return db.prepare(`SELECT * FROM fact_assertions WHERE id = ?`).get(id) as FactAssertionRow;
}

// ---------------------------------------------------------------------------
// createSupersessionProposal
// ---------------------------------------------------------------------------

export function createSupersessionProposal(
  db: DatabaseSync,
  input: SupersessionProposalInput,
  opts?: { namespace?: string | null },
): SupersessionProposalRow {
  const id = randomUUID();
  const now = Date.now();
  const namespace = opts?.namespace ?? null;

  db.prepare(
    `INSERT INTO supersession_proposals (id, target_entity_id, target_assertion_id, new_assertion_text, reason, status, evidence_unit_id, created_at, namespace) ` +
      `VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    id,
    input.targetEntityId,
    input.targetAssertionId ?? null,
    input.newAssertionText,
    input.reason ?? null,
    input.evidenceUnitId ?? null,
    now,
    namespace,
  );

  return db.prepare(`SELECT * FROM supersession_proposals WHERE id = ?`).get(id) as SupersessionProposalRow;
}

// ---------------------------------------------------------------------------
// resolveSupersession
// ---------------------------------------------------------------------------

export function resolveSupersession(
  db: DatabaseSync,
  proposalId: string,
  decision: "approved" | "rejected",
  opts?: { namespace?: string | null },
): SupersessionProposalRow | null {
  const now = Date.now();

  const existing = db
    .prepare(`SELECT * FROM supersession_proposals WHERE id = ? AND status = 'pending'`)
    .get(proposalId) as SupersessionProposalRow | undefined;

  if (!existing) return null;

  db.prepare(
    `UPDATE supersession_proposals SET status = ?, resolved_at = ? WHERE id = ?`,
  ).run(decision, now, proposalId);

  // If approved, mark the target assertion as superseded
  if (decision === "approved" && existing.target_assertion_id) {
    db.prepare(
      `UPDATE fact_assertions SET status = 'superseded', updated_at = ? WHERE id = ?`,
    ).run(now, existing.target_assertion_id);
  }

  return db.prepare(`SELECT * FROM supersession_proposals WHERE id = ?`).get(proposalId) as SupersessionProposalRow;
}

// ---------------------------------------------------------------------------
// getAssertionsForEntity
// ---------------------------------------------------------------------------

export function getAssertionsForEntity(
  db: DatabaseSync,
  entityId: string,
  opts?: { status?: string; namespace?: string | null; limit?: number },
): FactAssertionRow[] {
  const conditions: string[] = ["entity_id = ?"];
  const params: (string | number | null)[] = [entityId];

  if (opts?.status) {
    conditions.push("status = ?");
    params.push(opts.status);
  }

  const ns = nsCol(opts?.namespace ?? null);
  conditions.push(ns.clause);
  params.push(...ns.params);

  const limit = opts?.limit ?? 100;

  return db
    .prepare(
      `SELECT * FROM fact_assertions WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params, limit) as FactAssertionRow[];
}

// ---------------------------------------------------------------------------
// getPendingProposals
// ---------------------------------------------------------------------------

export function getPendingProposals(
  db: DatabaseSync,
  opts?: { targetEntityId?: string; namespace?: string | null; limit?: number },
): SupersessionProposalRow[] {
  const conditions: string[] = ["status = 'pending'"];
  const params: (string | number | null)[] = [];

  if (opts?.targetEntityId) {
    conditions.push("target_entity_id = ?");
    params.push(opts.targetEntityId);
  }

  const ns = nsCol(opts?.namespace ?? null);
  conditions.push(ns.clause);
  params.push(...ns.params);

  const limit = opts?.limit ?? 100;

  return db
    .prepare(
      `SELECT * FROM supersession_proposals WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params, limit) as SupersessionProposalRow[];
}
