/**
 * Document parsers for various formats.
 * Each parser converts raw content into DocumentChunk[].
 */

// Re-export once graph-import.ts is available:
//   import type { DocumentChunk } from "./graph-import.js";

export type DocumentChunk = {
  index: number;
  content: string;
  heading?: string;
  headingLevel?: number;
};

/**
 * Parse markdown content into chunks based on heading structure.
 * Each heading starts a new chunk. Content under each heading becomes one chunk.
 */
export function markdownParser(content: string): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  const lines = content.split("\n");

  let currentHeading: string | undefined;
  let currentLevel: number | undefined;
  let currentContent: string[] = [];

  const flush = () => {
    const text = currentContent.join("\n").trim();
    if (text.length > 0) {
      chunks.push({
        index: chunks.length,
        content: text,
        heading: currentHeading,
        headingLevel: currentLevel,
      });
    }
    currentContent = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flush();
      currentLevel = headingMatch[1]!.length;
      currentHeading = headingMatch[2]!.trim();
    } else {
      currentContent.push(line);
    }
  }

  flush();

  return chunks;
}

/**
 * Simple text parser — treats entire content as a single chunk.
 */
export function textParser(content: string): DocumentChunk[] {
  return [{ index: 0, content }];
}
