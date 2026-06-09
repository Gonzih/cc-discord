import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseRoutingTag } from "./router.js";

describe("parseRoutingTag", () => {
  beforeEach(() => {
    delete process.env.DEFAULT_GITHUB_ORG;
  });

  afterEach(() => {
    delete process.env.DEFAULT_GITHUB_ORG;
  });

  it("returns null when no #tag present", () => {
    expect(parseRoutingTag("just a regular message")).toBeNull();
  });

  it("returns null for #repo format without DEFAULT_GITHUB_ORG", () => {
    expect(parseRoutingTag("#my-repo fix the bug")).toBeNull();
  });

  it("parses #repo format when DEFAULT_GITHUB_ORG is set", () => {
    process.env.DEFAULT_GITHUB_ORG = "gonzih";
    const result = parseRoutingTag("#cc-agent fix the bug");
    expect(result).not.toBeNull();
    expect(result!.namespace).toBe("cc-agent");
    expect(result!.repoUrl).toBe("https://github.com/gonzih/cc-agent");
    expect(result!.strippedMessage).toBe("fix the bug");
  });

  it("parses #org/repo format without DEFAULT_GITHUB_ORG", () => {
    const result = parseRoutingTag("#gonzih/of-stack deploy it");
    expect(result).not.toBeNull();
    expect(result!.namespace).toBe("of-stack");
    expect(result!.repoUrl).toBe("https://github.com/gonzih/of-stack");
    expect(result!.strippedMessage).toBe("deploy it");
  });

  it("strips tag token from message", () => {
    process.env.DEFAULT_GITHUB_ORG = "acme";
    const result = parseRoutingTag("please help #my-repo with this");
    expect(result!.strippedMessage).toBe("please help with this");
  });

  it("returns empty strippedMessage when only tag present", () => {
    process.env.DEFAULT_GITHUB_ORG = "acme";
    const result = parseRoutingTag("#my-repo");
    expect(result!.strippedMessage).toBe("");
  });
});
