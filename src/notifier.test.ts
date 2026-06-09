import { describe, it, expect } from "vitest";
import { parseNotification } from "./notifier.js";

describe("parseNotification", () => {
  it("returns raw string when not JSON", () => {
    expect(parseNotification("plain text")).toBe("plain text");
  });

  it("extracts text from JSON payload", () => {
    const payload = JSON.stringify({ text: "job done" });
    expect(parseNotification(payload)).toBe("job done");
  });

  it("appends driver badge when driver is present", () => {
    const payload = JSON.stringify({ text: "done", driver: "claude" });
    expect(parseNotification(payload)).toBe("done\n[claude]");
  });

  it("appends driver:model badge when both present", () => {
    const payload = JSON.stringify({ text: "done", driver: "claude", model: "claude-sonnet-4-6" });
    expect(parseNotification(payload)).toBe("done\n[claude:sonnet-4-6]");
  });

  it("appends cost when numeric cost present", () => {
    const payload = JSON.stringify({ text: "done", driver: "claude", cost: 0.123 });
    expect(parseNotification(payload)).toBe("done\n[claude] cost: $0.123");
  });

  it("strips vendor prefix from openrouter-style model names", () => {
    const payload = JSON.stringify({ text: "done", driver: "openrouter", model: "openai/gpt-4o" });
    expect(parseNotification(payload)).toBe("done\n[openrouter:gpt-4o]");
  });

  it("returns text unchanged when no driver", () => {
    const payload = JSON.stringify({ text: "just text", model: "gpt-4" });
    expect(parseNotification(payload)).toBe("just text");
  });
});
