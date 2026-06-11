import { describe, it, expect } from "vitest";
import { parseNotification, resolveNotifyChannel } from "./notifier.js";

describe("resolveNotifyChannel", () => {
  it("returns reverseSnowflakeLookup result when chatId and lookup available", () => {
    const lookup = (n: number) => (n === 42 ? "channel-42" : undefined);
    expect(resolveNotifyChannel(42, "notify-channel", undefined, lookup)).toBe("channel-42");
  });

  it("falls back to notifyChannelId when reverseSnowflakeLookup returns undefined", () => {
    const lookup = (_n: number) => undefined;
    expect(resolveNotifyChannel(42, "notify-channel", undefined, lookup)).toBe("notify-channel");
  });

  it("falls back to notifyChannelId when chatId is undefined", () => {
    expect(resolveNotifyChannel(undefined, "notify-channel", undefined, undefined)).toBe("notify-channel");
  });

  it("falls back to getActiveChannelId when notifyChannelId is null", () => {
    expect(resolveNotifyChannel(undefined, null, () => "active-channel", undefined)).toBe("active-channel");
  });

  it("returns undefined when no fallbacks available", () => {
    expect(resolveNotifyChannel(undefined, null, undefined, undefined)).toBeUndefined();
  });
});

describe("parseNotification", () => {
  it("returns raw string when not JSON", () => {
    expect(parseNotification("plain text")).toEqual({ text: "plain text" });
  });

  it("extracts text from JSON payload", () => {
    const payload = JSON.stringify({ text: "job done" });
    expect(parseNotification(payload)).toEqual({ text: "job done" });
  });

  it("appends driver badge when driver is present", () => {
    const payload = JSON.stringify({ text: "done", driver: "claude" });
    expect(parseNotification(payload)).toEqual({ text: "done\n[claude]" });
  });

  it("appends driver:model badge when both present", () => {
    const payload = JSON.stringify({ text: "done", driver: "claude", model: "claude-sonnet-4-6" });
    expect(parseNotification(payload)).toEqual({ text: "done\n[claude:sonnet-4-6]" });
  });

  it("appends cost when numeric cost present", () => {
    const payload = JSON.stringify({ text: "done", driver: "claude", cost: 0.123 });
    expect(parseNotification(payload)).toEqual({ text: "done\n[claude] cost: $0.123" });
  });

  it("strips vendor prefix from openrouter-style model names", () => {
    const payload = JSON.stringify({ text: "done", driver: "openrouter", model: "openai/gpt-4o" });
    expect(parseNotification(payload)).toEqual({ text: "done\n[openrouter:gpt-4o]" });
  });

  it("returns text unchanged when no driver", () => {
    const payload = JSON.stringify({ text: "just text", model: "gpt-4" });
    expect(parseNotification(payload)).toEqual({ text: "just text" });
  });

  it("extracts chat_id from JSON payload", () => {
    const payload = JSON.stringify({ text: "job done", chat_id: 12345 });
    expect(parseNotification(payload)).toEqual({ text: "job done", chatId: 12345 });
  });

  it("ignores zero chat_id", () => {
    const payload = JSON.stringify({ text: "job done", chat_id: 0 });
    expect(parseNotification(payload)).toEqual({ text: "job done" });
  });

  it("extracts chat_id alongside driver badge", () => {
    const payload = JSON.stringify({ text: "done", driver: "claude", chat_id: 99 });
    expect(parseNotification(payload)).toEqual({ text: "done\n[claude]", chatId: 99 });
  });

  it("returns null when routing excludes discord", () => {
    const payload = JSON.stringify({ text: "done", routing: ["telegram"] });
    expect(parseNotification(payload)).toBeNull();
  });

  it("delivers when routing includes discord", () => {
    const payload = JSON.stringify({ text: "done", routing: ["discord"] });
    expect(parseNotification(payload)).toEqual({ text: "done" });
  });

  it("delivers when routing includes discord alongside other transports", () => {
    const payload = JSON.stringify({ text: "done", routing: ["discord", "telegram"] });
    expect(parseNotification(payload)).toEqual({ text: "done" });
  });

  it("delivers when routing is absent", () => {
    const payload = JSON.stringify({ text: "done" });
    expect(parseNotification(payload)).toEqual({ text: "done" });
  });

  it("delivers when routing is an empty array", () => {
    const payload = JSON.stringify({ text: "done", routing: [] });
    expect(parseNotification(payload)).toEqual({ text: "done" });
  });
});
