import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ensureGraphSchema, MemoryGraphEngine, buildL0Context, formatL0AsPromptSection,
  searchGraph, extractAndMerge, loadConfig, createLlmExtractFn, createEmbedFn, createRerankFn,
} from "mem-c";

export default {
  id: "mem-c",
  kind: "memory",
  configSchema: { type: "object", additionalProperties: false, properties: {
    dbPath: { type: "string" }, autoExtract: { type: "boolean" }, autoRecall: { type: "boolean" },
    recallMaxTokens: { type: "number" }, recallMaxEntities: { type: "number" },
    searchMaxResults: { type: "number" }, recallAvailableBudget: { type: "number" },
  }},
  register(api) {
    const cfg = api.config || {};
    const dbPath = cfg.dbPath || process.env.MEMC_DB_PATH || (process.env.HOME + "/.mem-c/graph.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath, { allowExtension: true });
    const { entityFtsAvailable, vecAvailable } = ensureGraphSchema({ db });
    let modelConfig = null;
    try { modelConfig = loadConfig(); } catch (e) { console.error("[mem-c] config:", e.message); }
    const embedFn = modelConfig && modelConfig.embedding ? createEmbedFn(modelConfig.embedding) : undefined;
    const engine = new MemoryGraphEngine(db, { embedFn });

    if (cfg.autoRecall !== false) {
      api.registerHook("before_agent_start", async (ctx) => {
        try {
          const l0 = buildL0Context(engine, { maxEntities: cfg.recallMaxEntities || 50, maxTokens: cfg.recallMaxTokens || 200, useImportance: true });
          if (l0.entries.length === 0) return;
          ctx.injectSystemPrompt(formatL0AsPromptSection(l0));
        } catch (e) { console.error("[mem-c] recall:", e.message); }
      });
    }

    if (cfg.autoExtract !== false) {
      const llmExtract = modelConfig && modelConfig.chat ? createLlmExtractFn(modelConfig.chat) : null;
      api.registerHook("agent_end", async (ctx) => {
        if (!llmExtract) return;
        try {
          const transcript = (ctx.getTranscript && ctx.getTranscript()) || "";
          if (transcript.length < 50) return;
          const r = await extractAndMerge({ engine, transcript, sessionKey: ctx.sessionKey || "default", llmExtract });
          if (r.entitiesCreated + r.edgesCreated > 0) console.error("[mem-c] extracted:", r.entitiesCreated, "entities,", r.edgesCreated, "edges");
        } catch (e) { console.error("[mem-c] extract:", e.message); }
      });
    }

    api.registerTool(function() { return {
      name: "memory_graph_search",
      description: "Search the knowledge graph for entities and relations.",
      parameters: { type: "object", properties: { query: { type: "string" }, types: { type: "array", items: { type: "string" } }, maxResults: { type: "number" }, includeRelations: { type: "boolean" } }, required: ["query"] },
      execute: async function(_tid, params) {
        var rerankFn = modelConfig && modelConfig.rerank ? createRerankFn(modelConfig.rerank) : undefined;
        var results = await searchGraph(db, engine, params.query, { maxResults: params.maxResults || cfg.searchMaxResults || 6, types: params.types, includeEdges: params.includeRelations !== false, rerankFn });
        var text = results.map(function(r) { return "- " + r.entity.name + " (" + r.entity.type + ")" + (r.entity.summary ? ": " + r.entity.summary : "") + " [" + r.score.toFixed(2) + "]"; }).join("\n");
        return { content: [{ type: "text", text: text || "No matching entities found." }] };
      }
    };});

    api.registerTool(function() { return {
      name: "memory_graph_store",
      description: "Store or update an entity.",
      parameters: { type: "object", properties: { name: { type: "string" }, type: { type: "string" }, summary: { type: "string" }, confidence: { type: "number" } }, required: ["name", "type"] },
      execute: function(_tid, params) {
        var e = engine.upsertEntity({ name: params.name, type: params.type, summary: params.summary, confidence: params.confidence || 1, source: "manual" });
        return { content: [{ type: "text", text: (e.isNew ? "Created" : "Updated") + ": " + e.name }] };
      }
    };});

    api.registerTool(function() { return {
      name: "memory_graph_detail",
      description: "Get entity details and relations.",
      parameters: { type: "object", properties: { name: { type: "string" }, depth: { type: "number" } }, required: ["name"] },
      execute: function(_tid, params) {
        var m = engine.findEntities({ name: params.name, activeOnly: true, limit: 1 });
        if (!m.length) return { content: [{ type: "text", text: "Not found: " + params.name }] };
        var e = m[0]; var n = engine.getNeighbors(e.id, params.depth || 1);
        var rels = n.edges.map(function(ed) { var f = engine.getEntity(ed.from_id); var t = engine.getEntity(ed.to_id); return (f && f.name || "?") + " --" + ed.relation + "--> " + (t && t.name || "?"); });
        return { content: [{ type: "text", text: JSON.stringify({ name: e.name, type: e.type, summary: e.summary, relations: rels }, null, 2) }] };
      }
    };});

    api.registerTool(function() { return {
      name: "memory_graph_invalidate",
      description: "Soft-delete an entity.",
      parameters: { type: "object", properties: { name: { type: "string" }, reason: { type: "string" } }, required: ["name"] },
      execute: function(_tid, params) {
        var m = engine.findEntities({ name: params.name, activeOnly: true, limit: 1 });
        if (!m.length) return { content: [{ type: "text", text: "Not found: " + params.name }] };
        engine.invalidateEntity(m[0].id, params.reason || "manual");
        return { content: [{ type: "text", text: "Invalidated: " + params.name }] };
      }
    };});

    console.error("[mem-c] loaded - " + (entityFtsAvailable ? "FTS" : "no-FTS") + ", " + (vecAvailable ? "vec" : "no-vec") + ", config: " + (modelConfig ? "yes" : "no"));
  },
};
