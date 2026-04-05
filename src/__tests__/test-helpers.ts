import { DatabaseSync } from "node:sqlite";
import { ensureGraphSchema } from "../host/graph-schema.js";

/** Create an in-memory SQLite database with the full graph schema. */
export function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureGraphSchema({ db, ftsEnabled: true });
  return db;
}
