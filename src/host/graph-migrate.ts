/**
 * Migration: import existing markdown memory files into the memory graph.
 *
 * Reads MEMORY.md index + memory/*.md files, parses frontmatter, and
 * creates entities with appropriate types. Existing entities are not
 * duplicated (upsert semantics).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryGraphEngine, EntityInput } from "./graph-engine.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MigrationResult = {
  filesProcessed: number;
  entitiesCreated: number;
  entitiesUpdated: number;
  errors: string[];
};

type MemoryFileFrontmatter = {
  name?: string;
  description?: string;
  type?: string;
};

// ---------------------------------------------------------------------------
// Frontmatter parser (simple, no external deps)
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): { frontmatter: MemoryFileFrontmatter; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const raw = match[1]!;
  const body = match[2]!;
  const frontmatter: MemoryFileFrontmatter = {};

  for (const line of raw.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key === "name") frontmatter.name = value;
    else if (key === "description") frontmatter.description = value;
    else if (key === "type") frontmatter.type = value;
  }

  return { frontmatter, body };
}

/** Map memory file `type` field to graph entity type. */
function mapMemoryTypeToEntityType(memoryType?: string): string {
  switch (memoryType) {
    case "user":
      return "user";
    case "feedback":
      return "feedback";
    case "project":
      return "project";
    case "reference":
      return "concept";
    default:
      return "concept";
  }
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Import markdown memory files from a workspace directory into the graph.
 *
 * Scans `MEMORY.md`, `memory.md`, and `memory/` directory for `.md` files.
 * Parses frontmatter for name, description, and type.
 * Creates or updates entities in the graph.
 */
export async function migrateMarkdownMemory(params: {
  engine: MemoryGraphEngine;
  workspaceDir: string;
}): Promise<MigrationResult> {
  const { engine, workspaceDir } = params;
  const result: MigrationResult = {
    filesProcessed: 0,
    entitiesCreated: 0,
    entitiesUpdated: 0,
    errors: [],
  };

  // Collect memory files
  const memoryFiles: string[] = [];

  // Check MEMORY.md / memory.md (index files — skip, they are just pointers)
  // Process individual memory files in memory/ directory
  const memoryDir = path.join(workspaceDir, "memory");
  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        memoryFiles.push(path.join(memoryDir, entry.name));
      }
    }
  } catch {
    // No memory directory — nothing to migrate
  }

  // Also check for standalone MEMORY.md with inline content
  for (const name of ["MEMORY.md", "memory.md"]) {
    const filePath = path.join(workspaceDir, name);
    try {
      await fs.access(filePath);
      // MEMORY.md is typically an index; only import if it has frontmatter
      const content = await fs.readFile(filePath, "utf-8");
      const { frontmatter } = parseFrontmatter(content);
      if (frontmatter.name) {
        memoryFiles.push(filePath);
      }
    } catch {
      // File doesn't exist
    }
  }

  // Process each file
  for (const filePath of memoryFiles) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const { frontmatter, body } = parseFrontmatter(content);

      const fileName = path.basename(filePath, ".md");
      const name = frontmatter.name || fileName;
      const entityType = mapMemoryTypeToEntityType(frontmatter.type);

      // Use description as summary, or first non-empty line of body
      let summary = frontmatter.description;
      if (!summary) {
        const firstLine = body
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("-"));
        if (firstLine) {
          summary = firstLine.length > 200 ? firstLine.slice(0, 200) + "..." : firstLine;
        }
      }

      const existing = engine.findEntities({
        name,
        type: entityType,
        activeOnly: true,
        limit: 1,
      });

      engine.upsertEntity({
        name,
        type: entityType,
        summary,
        confidence: 1.0,
        source: "imported",
      });

      result.filesProcessed++;
      if (existing.length > 0) {
        result.entitiesUpdated++;
      } else {
        result.entitiesCreated++;
      }
    } catch (err) {
      result.errors.push(
        `Failed to process ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}
