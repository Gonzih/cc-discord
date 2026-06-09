import { describe, it, expect } from "vitest";
import { formatForDiscord, splitLongMessage, stripAnsi } from "./formatter.js";

describe("formatForDiscord", () => {
  it("converts headings to bold", () => {
    expect(formatForDiscord("## Hello World")).toBe("**Hello World**");
  });

  it("converts h1 to bold", () => {
    expect(formatForDiscord("# Title")).toBe("**Title**");
  });

  it("converts h6 to bold", () => {
    expect(formatForDiscord("###### Deep")).toBe("**Deep**");
  });

  it("replaces --- with empty line", () => {
    expect(formatForDiscord("---")).toBe("");
  });

  it("preserves code blocks unchanged", () => {
    const input = "```js\nconsole.log('hello');\n```";
    expect(formatForDiscord(input)).toBe(input);
  });

  it("preserves inline code unchanged", () => {
    const input = "Use `npm install` to install";
    expect(formatForDiscord(input)).toBe(input);
  });

  it("preserves **bold** as-is for Discord native rendering", () => {
    const input = "This is **bold** text";
    expect(formatForDiscord(input)).toBe("This is **bold** text");
  });

  it("does not double-bold code inside headings", () => {
    const result = formatForDiscord("## `code` heading");
    expect(result).toBe("**`code` heading**");
  });
});

describe("splitLongMessage", () => {
  it("returns single chunk for short messages", () => {
    const msg = "Hello world";
    expect(splitLongMessage(msg, 2000)).toEqual(["Hello world"]);
  });

  it("splits at paragraph boundary", () => {
    const msg = "paragraph one\n\nparagraph two";
    // Each paragraph is well under 2000 chars — should stay as one
    expect(splitLongMessage(msg, 2000)).toEqual(["paragraph one\n\nparagraph two"]);
  });

  it("splits long text into chunks under maxLen", () => {
    const longText = "word ".repeat(500); // 2500 chars
    const chunks = splitLongMessage(longText, 100);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
    // Reassembled content should equal original (minus trimming)
    const reassembled = chunks.join(" ");
    expect(reassembled.replace(/\s+/g, " ").trim()).toBe(longText.trim());
  });

  it("respects 2000 char default limit", () => {
    const longText = "a".repeat(5000);
    const chunks = splitLongMessage(longText);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });
});

describe("stripAnsi", () => {
  it("removes ANSI color codes", () => {
    expect(stripAnsi("\x1B[32mgreen\x1B[0m")).toBe("green");
  });

  it("removes bold ANSI", () => {
    expect(stripAnsi("\x1B[1mbold\x1B[0m")).toBe("bold");
  });

  it("leaves normal text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });
});
