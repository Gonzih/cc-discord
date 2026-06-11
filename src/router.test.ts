import { describe, it, expect } from "vitest";
import { parseChannelCreateIntent } from "./router.js";

describe("parseChannelCreateIntent", () => {
  it("returns null for a regular message", () => {
    expect(parseChannelCreateIntent("just a regular message")).toBeNull();
  });

  it("returns null when URL is not a github.com URL", () => {
    expect(parseChannelCreateIntent("channel for https://example.com/org/repo")).toBeNull();
  });

  it("parses bare 'channel for URL' form", () => {
    const result = parseChannelCreateIntent("channel for https://github.com/gonzih/metaweb-future-path");
    expect(result).not.toBeNull();
    expect(result!.namespace).toBe("metaweb-future-path");
    expect(result!.repoUrl).toBe("https://github.com/gonzih/metaweb-future-path");
  });

  it("parses 'create channel for URL' form", () => {
    const result = parseChannelCreateIntent("create channel for https://github.com/org/repo");
    expect(result).not.toBeNull();
    expect(result!.namespace).toBe("repo");
    expect(result!.repoUrl).toBe("https://github.com/org/repo");
  });

  it("parses 'add channel for URL' form", () => {
    const result = parseChannelCreateIntent("add channel for https://github.com/acme/my-service");
    expect(result).not.toBeNull();
    expect(result!.namespace).toBe("my-service");
    expect(result!.repoUrl).toBe("https://github.com/acme/my-service");
  });

  it("is case-insensitive", () => {
    const result = parseChannelCreateIntent("Channel For https://github.com/org/repo");
    expect(result).not.toBeNull();
    expect(result!.namespace).toBe("repo");
  });

  it("returns null when no URL follows 'channel for'", () => {
    expect(parseChannelCreateIntent("channel for something")).toBeNull();
  });
});
