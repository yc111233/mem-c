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

/**
 * Factory for PDF parser. The caller provides a function that extracts
 * text from a PDF buffer. This keeps the library dependency-free.
 *
 * Usage:
 *   import pdfParse from "pdf-parse";
 *   const parser = pdfParser(async (content) => (await pdfParse(Buffer.from(content, "utf-8"))).text);
 *   const result = await importDocument(engine, { content: pdfBuffer.toString(), parser, llmExtract });
 */
export function pdfParser(
  extractText: (content: string) => Promise<string>,
): (content: string) => Promise<DocumentChunk[]> {
  return async (content: string) => {
    const text = await extractText(content);
    // Split on page breaks (form feed) or double newlines
    const pages = text.split(/\f|\n{3,}/);
    return pages
      .map((page) => page.trim())
      .filter((page) => page.length > 0)
      .map((page, index) => ({ index, content: page }));
  };
}

/**
 * Factory for Feishu document parser.
 * The caller provides a function that fetches document content from a Feishu URL.
 *
 * Usage:
 *   const parser = feishuParser(async (url) => await feishuFetch(url));
 *   const result = await importDocument(engine, { content: feishuUrl, parser, llmExtract });
 */
export function feishuParser(
  fetchContent: (url: string) => Promise<string>,
): (url: string) => Promise<DocumentChunk[]> {
  return async (url: string) => {
    const text = await fetchContent(url);
    // Use markdown parser on the fetched content (Feishu docs export as markdown)
    return markdownParser(text);
  };
}
