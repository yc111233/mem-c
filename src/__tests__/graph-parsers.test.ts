import { describe, expect, it } from "vitest";
import { markdownParser, textParser, pdfParser, feishuParser } from "../host/graph-parsers.js";

describe("markdownParser", () => {
  it("splits on headings", () => {
    const md = `# Title

Some intro text.

## Section 1

Content of section 1.

## Section 2

Content of section 2.`;

    const chunks = markdownParser(md);
    expect(chunks.length).toBe(3);
    expect(chunks[0]!.heading).toBe("Title");
    expect(chunks[1]!.heading).toBe("Section 1");
    expect(chunks[2]!.heading).toBe("Section 2");
  });

  it("preserves heading levels", () => {
    const md = `## H2

Content.

### H3

Sub-content.`;

    const chunks = markdownParser(md);
    expect(chunks[0]!.headingLevel).toBe(2);
    expect(chunks[1]!.headingLevel).toBe(3);
  });

  it("handles document with no headings", () => {
    const md = "Just plain text with no headings.";
    const chunks = markdownParser(md);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.content).toBe(md);
  });

  it("skips empty sections", () => {
    const md = `## Empty Section

## Non-empty Section

Has content.`;

    const chunks = markdownParser(md);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.heading).toBe("Non-empty Section");
  });

  it("assigns sequential indices", () => {
    const md = `## A\n\nContent.\n\n## B\n\nMore.`;
    const chunks = markdownParser(md);
    expect(chunks[0]!.index).toBe(0);
    expect(chunks[1]!.index).toBe(1);
  });
});

describe("textParser", () => {
  it("returns single chunk", () => {
    const chunks = textParser("Hello world");
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.content).toBe("Hello world");
  });
});

describe("pdfParser", () => {
  it("splits on form feed (page breaks)", async () => {
    const parser = pdfParser(async (content) => content);
    const chunks = await parser("Page 1 content.\fPage 2 content.\fPage 3 content.");
    expect(chunks.length).toBe(3);
    expect(chunks[0]!.content).toBe("Page 1 content.");
    expect(chunks[1]!.content).toBe("Page 2 content.");
  });

  it("splits on triple newlines when no form feed", async () => {
    const parser = pdfParser(async (content) => content);
    const chunks = await parser("Section 1.\n\n\nSection 2.");
    expect(chunks.length).toBe(2);
  });

  it("handles empty content", async () => {
    const parser = pdfParser(async (content) => content);
    const chunks = await parser("");
    expect(chunks.length).toBe(0);
  });
});

describe("feishuParser", () => {
  it("fetches and parses as markdown", async () => {
    const parser = feishuParser(async (url) => `# Doc Title\n\nContent from ${url}`);
    const chunks = await parser("https://feishu.cn/docx/abc123");
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.some((c) => c.content.includes("abc123"))).toBe(true);
  });
});
