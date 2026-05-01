/**
 * Entity linking: explainable, controllable replacement for brute-force merge.
 *
 * Instead of "same name = merge", scores candidate pairs on multiple signals
 * and returns a LinkDecision with evidence.
 */

import { normalizeEntityName, type MemoryGraphEngine, type Entity } from "./graph-engine.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LinkDecision = "same_as" | "alias_of" | "possibly_same_as" | "distinct";

export type LinkCandidate = {
  entityA: Entity;
  entityB: Entity;
};

export type LinkResult = {
  decision: LinkDecision;
  score: number;
  evidence: string[];
};

export type LinkerOpts = {
  /** Min score for same_as decision. Default 0.8 */
  sameAsThreshold?: number;
  /** Min score for possibly_same_as. Default 0.5 */
  possibleThreshold?: number;
};

// ---------------------------------------------------------------------------
// Type compatibility
// ---------------------------------------------------------------------------

const COMPATIBLE_TYPES = new Map<string, Set<string>>([
  ["user", new Set(["user"])],
  ["person", new Set(["person"])],
  ["project", new Set(["project"])],
  ["concept", new Set(["concept"])],
  ["file", new Set(["file"])],
  ["decision", new Set(["decision"])],
  ["feedback", new Set(["feedback"])],
  ["tool", new Set(["tool"])],
  ["preference", new Set(["preference"])],
  ["event", new Set(["event"])],
  ["skill", new Set(["skill"])],
  ["location", new Set(["location"])],
  ["habit", new Set(["habit"])],
]);

function isTypeCompatible(typeA: string, typeB: string): boolean {
  const compatible = COMPATIBLE_TYPES.get(typeA);
  return compatible?.has(typeB) ?? (typeA === typeB);
}

// ---------------------------------------------------------------------------
// Cosine similarity (local copy — graph-search's is not exported)
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

// ---------------------------------------------------------------------------
// Core linking
// ---------------------------------------------------------------------------

export function linkEntities(
  engine: MemoryGraphEngine,
  candidate: LinkCandidate,
  opts?: LinkerOpts,
): LinkResult {
  const { entityA, entityB } = candidate;
  const sameAsThreshold = opts?.sameAsThreshold ?? 0.8;
  const possibleThreshold = opts?.possibleThreshold ?? 0.5;

  const evidence: string[] = [];
  let score = 0;

  // 1. Type compatibility check
  if (!isTypeCompatible(entityA.type, entityB.type)) {
    return { decision: "distinct", score: 0, evidence: ["cross-type incompatible"] };
  }
  evidence.push(`type match: ${entityA.type}`);
  score += 0.3;

  // 2. Name similarity
  const nameA = normalizeEntityName(entityA.name);
  const nameB = normalizeEntityName(entityB.name);
  if (nameA === nameB) {
    score += 0.5;
    evidence.push("exact name match (normalized)");
  } else if (nameA.includes(nameB) || nameB.includes(nameA)) {
    score += 0.2;
    evidence.push("name substring match");
  }

  // 3. Alias check (exclude the normalized name itself to avoid double-counting with name match)
  const aliasesA = engine.getAliases(entityA.id);
  const aliasesB = engine.getAliases(entityB.id);
  const hasAliasMatch =
    (aliasesA.has(nameB) && nameB !== nameA) ||
    (aliasesB.has(nameA) && nameA !== nameB);
  if (hasAliasMatch) {
    score += 0.2;
    evidence.push("alias match");
  }

  // 4. Embedding similarity
  if (entityA.embeddingVector && entityB.embeddingVector) {
    const sim = cosineSimilarity(entityA.embeddingVector, entityB.embeddingVector);
    if (sim > 0.9) {
      score += 0.2;
      evidence.push(`embedding similarity: ${sim.toFixed(3)}`);
    } else if (sim > 0.7) {
      score += 0.1;
      evidence.push(`embedding moderate similarity: ${sim.toFixed(3)}`);
    }
  }

  // 5. Shared neighbors
  const neighborsA = engine.getNeighbors(entityA.id, 1);
  const neighborsB = engine.getNeighbors(entityB.id, 1);
  const sharedIds = new Set(neighborsA.entities.map((e) => e.id));
  let sharedCount = 0;
  for (const e of neighborsB.entities) {
    if (sharedIds.has(e.id) && e.id !== entityA.id && e.id !== entityB.id) sharedCount++;
  }
  if (sharedCount >= 2) {
    score += 0.1;
    evidence.push(`${sharedCount} shared neighbors`);
  }

  // Decision
  let decision: LinkDecision;
  if (score >= sameAsThreshold) {
    decision = "same_as";
  } else if (score >= possibleThreshold) {
    decision = "possibly_same_as";
  } else {
    decision = "distinct";
  }

  return { decision, score: Math.min(1, score), evidence };
}

// ---------------------------------------------------------------------------
// Candidate discovery
// ---------------------------------------------------------------------------

export function findLinkCandidates(
  engine: MemoryGraphEngine,
  opts?: { maxCandidates?: number },
): LinkCandidate[] {
  const entities = engine.getActiveEntities();
  const byName = new Map<string, Entity[]>();
  for (const e of entities) {
    const key = normalizeEntityName(e.name);
    const group = byName.get(key) ?? [];
    group.push(e);
    byName.set(key, group);
  }

  const candidates: LinkCandidate[] = [];
  for (const [, group] of byName) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        candidates.push({ entityA: group[i]!, entityB: group[j]! });
      }
    }
  }

  return candidates.slice(0, opts?.maxCandidates ?? 100);
}
