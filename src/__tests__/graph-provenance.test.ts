import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGraphEngine } from "../host/graph-engine.js";
import {
  recordTextUnit,
  recordAssertion,
  createSupersessionProposal,
  resolveSupersession,
  getAssertionsForEntity,
  getPendingProposals,
} from "../host/graph-provenance.js";
import { ensureGraphSchema } from "../host/graph-schema.js";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureGraphSchema({ db, ftsEnabled: true });
  return db;
}

describe("graph-provenance", () => {
  let db: DatabaseSync;
  let engine: MemoryGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new MemoryGraphEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("recordTextUnit", () => {
    it("inserts a text unit linked to an episode", () => {
      const episode = engine.recordEpisode({
        sessionKey: "s1",
        content: "Hello world",
      });

      const unit = recordTextUnit(db, {
        episodeId: episode.id,
        content: "Hello world",
        turnIndex: 0,
        speaker: "user",
      });

      expect(unit.id).toBeDefined();
      expect(unit.episode_id).toBe(episode.id);
      expect(unit.content).toBe("Hello world");
      expect(unit.speaker).toBe("user");
      expect(unit.turn_index).toBe(0);
      expect(unit.created_at).toBeGreaterThan(0);
    });

    it("respects namespace", () => {
      const episode = engine.recordEpisode({
        sessionKey: "s1",
        content: "test",
      });

      const unit = recordTextUnit(db, {
        episodeId: episode.id,
        content: "test",
      }, { namespace: "ns1" });

      expect(unit.namespace).toBe("ns1");
    });
  });

  describe("recordAssertion", () => {
    it("inserts a fact assertion linked to an entity", () => {
      const entity = engine.upsertEntity({
        name: "React",
        type: "concept",
        summary: "A UI library",
      });

      const assertion = recordAssertion(db, {
        entityId: entity.id,
        assertionText: "React is a UI library by Meta",
        confidence: 0.9,
      });

      expect(assertion.id).toBeDefined();
      expect(assertion.entity_id).toBe(entity.id);
      expect(assertion.assertion_text).toBe("React is a UI library by Meta");
      expect(assertion.confidence).toBe(0.9);
      expect(assertion.status).toBe("active");
    });

    it("can link to a source text unit", () => {
      const episode = engine.recordEpisode({
        sessionKey: "s1",
        content: "React is great",
      });
      const unit = recordTextUnit(db, {
        episodeId: episode.id,
        content: "React is great",
      });
      const entity = engine.upsertEntity({
        name: "React",
        type: "concept",
      });

      const assertion = recordAssertion(db, {
        entityId: entity.id,
        assertionText: "React is great",
        sourceUnitId: unit.id,
      });

      expect(assertion.source_unit_id).toBe(unit.id);
    });
  });

  describe("createSupersessionProposal", () => {
    it("creates a pending proposal", () => {
      const entity = engine.upsertEntity({
        name: "Old API",
        type: "concept",
        summary: "v1",
      });

      const proposal = createSupersessionProposal(db, {
        targetEntityId: entity.id,
        newAssertionText: "Old API replaced by New API",
        reason: "migration completed",
      });

      expect(proposal.id).toBeDefined();
      expect(proposal.target_entity_id).toBe(entity.id);
      expect(proposal.status).toBe("pending");
      expect(proposal.new_assertion_text).toBe("Old API replaced by New API");
      expect(proposal.reason).toBe("migration completed");
      expect(proposal.resolved_at).toBeNull();
    });
  });

  describe("resolveSupersession", () => {
    it("approves a proposal and marks target assertion as superseded", () => {
      const entity = engine.upsertEntity({
        name: "Old API",
        type: "concept",
        summary: "v1",
      });
      const assertion = recordAssertion(db, {
        entityId: entity.id,
        assertionText: "Old API v1",
      });
      const proposal = createSupersessionProposal(db, {
        targetEntityId: entity.id,
        targetAssertionId: assertion.id,
        newAssertionText: "Old API replaced by New API",
      });

      const resolved = resolveSupersession(db, proposal.id, "approved");

      expect(resolved).not.toBeNull();
      expect(resolved!.status).toBe("approved");
      expect(resolved!.resolved_at).toBeGreaterThan(0);

      // Target assertion should be superseded
      const assertions = getAssertionsForEntity(db, entity.id);
      expect(assertions[0]!.status).toBe("superseded");
    });

    it("rejects a proposal without affecting assertions", () => {
      const entity = engine.upsertEntity({
        name: "Old API",
        type: "concept",
        summary: "v1",
      });
      const assertion = recordAssertion(db, {
        entityId: entity.id,
        assertionText: "Old API v1",
      });
      const proposal = createSupersessionProposal(db, {
        targetEntityId: entity.id,
        targetAssertionId: assertion.id,
        newAssertionText: "Wrong info",
      });

      const resolved = resolveSupersession(db, proposal.id, "rejected");

      expect(resolved).not.toBeNull();
      expect(resolved!.status).toBe("rejected");

      // Target assertion should still be active
      const assertions = getAssertionsForEntity(db, entity.id);
      expect(assertions[0]!.status).toBe("active");
    });

    it("returns null for non-existent or already resolved proposals", () => {
      const result = resolveSupersession(db, "non-existent", "approved");
      expect(result).toBeNull();
    });
  });

  describe("getAssertionsForEntity", () => {
    it("returns assertions for an entity", () => {
      const entity = engine.upsertEntity({
        name: "React",
        type: "concept",
      });
      recordAssertion(db, { entityId: entity.id, assertionText: "fact 1" });
      recordAssertion(db, { entityId: entity.id, assertionText: "fact 2" });

      const assertions = getAssertionsForEntity(db, entity.id);
      expect(assertions).toHaveLength(2);
    });

    it("filters by status", () => {
      const entity = engine.upsertEntity({
        name: "React",
        type: "concept",
      });
      const a1 = recordAssertion(db, { entityId: entity.id, assertionText: "fact 1" });
      recordAssertion(db, { entityId: entity.id, assertionText: "fact 2" });
      // Supersede one
      db.prepare(`UPDATE fact_assertions SET status = 'superseded' WHERE id = ?`).run(a1.id);

      const active = getAssertionsForEntity(db, entity.id, { status: "active" });
      expect(active).toHaveLength(1);
      expect(active[0]!.assertion_text).toBe("fact 2");
    });
  });

  describe("getPendingProposals", () => {
    it("returns pending proposals", () => {
      const entity = engine.upsertEntity({
        name: "Old API",
        type: "concept",
      });
      createSupersessionProposal(db, {
        targetEntityId: entity.id,
        newAssertionText: "replaced",
      });

      const proposals = getPendingProposals(db);
      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.status).toBe("pending");
    });

    it("excludes resolved proposals", () => {
      const entity = engine.upsertEntity({
        name: "Old API",
        type: "concept",
      });
      const p = createSupersessionProposal(db, {
        targetEntityId: entity.id,
        newAssertionText: "replaced",
      });
      resolveSupersession(db, p.id, "approved");

      const proposals = getPendingProposals(db);
      expect(proposals).toHaveLength(0);
    });

    it("filters by target entity", () => {
      const e1 = engine.upsertEntity({ name: "A", type: "concept" });
      const e2 = engine.upsertEntity({ name: "B", type: "concept" });
      createSupersessionProposal(db, { targetEntityId: e1.id, newAssertionText: "x" });
      createSupersessionProposal(db, { targetEntityId: e2.id, newAssertionText: "y" });

      const proposals = getPendingProposals(db, { targetEntityId: e1.id });
      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.target_entity_id).toBe(e1.id);
    });
  });

  describe("engine integration", () => {
    it("engine methods delegate to provenance module", () => {
      const entity = engine.upsertEntity({ name: "Test", type: "concept" });

      const assertion = engine.recordAssertion({
        entityId: entity.id,
        assertionText: "a fact",
      });
      expect(assertion.status).toBe("active");

      const proposal = engine.createSupersessionProposal({
        targetEntityId: entity.id,
        newAssertionText: "new info",
      });
      expect(proposal.status).toBe("pending");

      const pending = engine.getPendingProposals();
      expect(pending).toHaveLength(1);

      engine.resolveSupersession(proposal.id, "approved");
      const afterResolve = engine.getPendingProposals();
      expect(afterResolve).toHaveLength(0);
    });
  });
});
