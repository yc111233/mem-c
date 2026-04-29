import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { MemoryGraphEngine } from "./graph-engine.js";
import { ensureGraphSchema } from "./graph-schema.js";
import {
  memoryGraphSearch,
  memoryStore,
  memoryDetail,
  memoryInvalidate,
  memoryDetectCommunities,
  memoryFindPaths,
  memoryExportGraph,
} from "./graph-tools.js";

export type RestServerOpts = {
  port?: number;
  host?: string;
  dbPath?: string;
  namespace?: string;
};

export function createRestServer(opts?: RestServerOpts): {
  server: Server;
  engine: MemoryGraphEngine;
  db: DatabaseSync;
} {
  const dbPath = opts?.dbPath ?? ":memory:";
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  const engine = new MemoryGraphEngine(db, { namespace: opts?.namespace });
  ensureGraphSchema({ db, engine, ftsEnabled: true });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const method = req.method ?? "GET";

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");

    const send = (data: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(data));
    };

    const readBody = (): Promise<string> =>
      new Promise((resolve) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => resolve(body));
      });

    // GET /search?q=...
    if (method === "GET" && url.pathname === "/search") {
      const query = url.searchParams.get("q") ?? "";
      const result = await memoryGraphSearch(db, engine, { query });
      return send(result);
    }

    // POST /entities
    if (method === "POST" && url.pathname === "/entities") {
      return readBody().then((body) => {
        const input = JSON.parse(body);
        const result = memoryStore(engine, input);
        send(result, 201);
      });
    }

    // GET /entities/:name
    if (method === "GET" && url.pathname.startsWith("/entities/")) {
      const name = decodeURIComponent(url.pathname.slice("/entities/".length));
      const result = memoryDetail(engine, { entity: name });
      return send(result);
    }

    // DELETE /entities/:name
    if (method === "DELETE" && url.pathname.startsWith("/entities/")) {
      const name = decodeURIComponent(url.pathname.slice("/entities/".length));
      const result = memoryInvalidate(engine, { entity: name });
      return send(result);
    }

    // GET /communities
    if (method === "GET" && url.pathname === "/communities") {
      const result = memoryDetectCommunities(engine, {});
      return send(result);
    }

    // GET /paths?from=X&to=Y
    if (method === "GET" && url.pathname === "/paths") {
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      const result = memoryFindPaths(engine, { from, to });
      return send(result);
    }

    // GET /export?format=mermaid
    if (method === "GET" && url.pathname === "/export") {
      const format = (url.searchParams.get("format") as "mermaid" | "dot" | "json") ?? "mermaid";
      const result = memoryExportGraph(engine, { format });
      return send(result);
    }

    // GET /health
    if (method === "GET" && url.pathname === "/health") {
      const stats = engine.stats();
      return send({ status: "ok", ...stats });
    }

    // OPTIONS (CORS)
    if (method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.statusCode = 204;
      return res.end();
    }

    send({ error: "Not found" }, 404);
  });

  return { server, engine, db };
}

export function startRestServer(opts?: RestServerOpts): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const { server, db } = createRestServer(opts);
    const port = opts?.port ?? 0;

    server.on("error", (err: Error) => {
      db.close();
      reject(err);
    });

    server.listen(port, opts?.host ?? "127.0.0.1", () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        port: actualPort,
        close: () => {
          server.close();
          db.close();
        },
      });
    });
  });
}
