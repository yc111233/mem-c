import { describe, expect, it } from "vitest";
import { markdownParser, textParser } from "../host/graph-parsers.js";

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
