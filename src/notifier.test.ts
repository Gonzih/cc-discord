import { describe, it, expect, vi, afterEach } from "vitest";
import { parseNotification, resolveNotifyChannel, startNotifier } from "./notifier.js";
import { notifyListKey } from "@gonzih/cc-wire";

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

/** Build the minimal mocks needed to call startNotifier without a real Redis or Discord client. */
function buildMocks() {
  // Track messages sent by the bot
  const sent: Array<{ channelId: string; text: string }> = [];
  const stoppedTyping: string[] = [];
  const mockBot = {
    sendToChannelById: vi.fn((channelId: string, text: string) => {
      sent.push({ channelId, text });
      return Promise.resolve();
    }),
    stopMetaAgentTyping: vi.fn((channelId: string) => {
      stoppedTyping.push(channelId);
    }),
  };

  // Subscriber redis (returned by redis.duplicate()) — events are emitted manually in tests
  const subHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const mockSub = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      subHandlers[event] = subHandlers[event] ?? [];
      subHandlers[event].push(handler);
    }),
    subscribe: vi.fn((_ch: string, cb?: (err: Error | null) => void) => cb?.(null)),
    psubscribe: vi.fn((_pat: string, cb?: (err: Error | null) => void) => cb?.(null)),
    emit: (event: string, ...args: unknown[]) => {
      subHandlers[event]?.forEach((h) => h(...args));
    },
  };

  // Queued rpop responses per list key
  const listQueues = new Map<string, string[]>();
  const mockRedis = {
    duplicate: vi.fn().mockReturnValue(mockSub),
    rpop: vi.fn(async (key: string) => {
      const q = listQueues.get(key) ?? [];
      return q.shift() ?? null;
    }),
    llen: vi.fn().mockResolvedValue(0),
  };

  return { mockBot, mockSub, mockRedis, sent, stoppedTyping, listQueues };
}

describe("startNotifier — pmessage (cca:chat:outgoing:*)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards primary namespace meta-agent output to the primary Discord notify channel", async () => {
    vi.useFakeTimers();
    const { mockBot, mockSub, mockRedis, sent } = buildMocks();

    startNotifier(
      mockBot as never,
      "primary-notify-ch",
      "money-brain",
      mockRedis as never,
    );

    const msg = JSON.stringify({ source: "claude", content: "cron response" });
    mockSub.emit("pmessage", "cca:chat:outgoing:*", "cca:chat:outgoing:money-brain", msg);

    await vi.advanceTimersByTimeAsync(2_000);

    // Primary namespace chat output now goes to BOTH Telegram (via cc-tg) AND Discord (via notifyChannelId)
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channelId: "primary-notify-ch" });
  });

  it("forwards routed namespace meta-agent output to the registered Discord channel", async () => {
    vi.useFakeTimers();
    const { mockBot, mockSub, mockRedis, sent } = buildMocks();

    const handle = startNotifier(
      mockBot as never,
      "primary-notify-ch",
      "money-brain",
      mockRedis as never,
    );

    handle.registerRoutedChannelId("simorgh", "discord-ch-555");

    const msg = JSON.stringify({ source: "claude", content: "routed response" });
    mockSub.emit("pmessage", "cca:chat:outgoing:*", "cca:chat:outgoing:simorgh", msg);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(sent).toContainEqual(expect.objectContaining({ channelId: "discord-ch-555" }));
    expect(sent.every((m) => m.channelId !== "primary-notify-ch")).toBe(true);
  });

  it("calls stopMetaAgentTyping on the target channel when meta-agent buffer flushes", async () => {
    vi.useFakeTimers();
    const { mockBot, mockSub, mockRedis, stoppedTyping } = buildMocks();

    const handle = startNotifier(
      mockBot as never,
      "primary-notify-ch",
      "money-brain",
      mockRedis as never,
    );

    handle.registerRoutedChannelId("simorgh", "discord-ch-888");

    const msg = JSON.stringify({ source: "claude", content: "agent reply" });
    mockSub.emit("pmessage", "cca:chat:outgoing:*", "cca:chat:outgoing:simorgh", msg);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(stoppedTyping).toContain("discord-ch-888");
  });
});

describe("startNotifier — per-namespace list polling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls notifyListKey for routed namespaces after registerRoutedChannelId", async () => {
    vi.useFakeTimers();
    const { mockBot, mockRedis, sent, listQueues } = buildMocks();

    const routedListKey = notifyListKey("simorgh");
    listQueues.set(routedListKey, [JSON.stringify({ text: "job done" })]);

    const handle = startNotifier(
      mockBot as never,
      null,
      "money-brain",
      mockRedis as never,
    );

    handle.registerRoutedChannelId("simorgh", "discord-ch-999");

    // Advance past the 5-second poll interval
    await vi.advanceTimersByTimeAsync(5_100);

    expect(sent).toContainEqual({ channelId: "discord-ch-999", text: "job done" });
  });

  it("does not deliver routed-namespace notifications to the primary channel", async () => {
    vi.useFakeTimers();
    const { mockBot, mockRedis, sent, listQueues } = buildMocks();

    const routedListKey = notifyListKey("simorgh");
    listQueues.set(routedListKey, [JSON.stringify({ text: "simorgh update" })]);

    const handle = startNotifier(
      mockBot as never,
      "primary-notify-ch",
      "money-brain",
      mockRedis as never,
    );

    handle.registerRoutedChannelId("simorgh", "discord-ch-777");

    await vi.advanceTimersByTimeAsync(5_100);

    // Notification goes to the routed channel, NOT to primary-notify-ch
    expect(sent).toContainEqual({ channelId: "discord-ch-777", text: "simorgh update" });
    expect(sent.every((m) => m.channelId !== "primary-notify-ch")).toBe(true);
  });

  it("routes primary-namespace notifications to notifyChannelId", async () => {
    vi.useFakeTimers();
    const { mockBot, mockRedis, sent, listQueues } = buildMocks();

    const primaryListKey = notifyListKey("money-brain");
    listQueues.set(primaryListKey, [JSON.stringify({ text: "primary done" })]);

    startNotifier(
      mockBot as never,
      "primary-notify-ch",
      "money-brain",
      mockRedis as never,
    );

    await vi.advanceTimersByTimeAsync(5_100);

    expect(sent).toContainEqual({ channelId: "primary-notify-ch", text: "primary done" });
  });

  it("skips routing-excluded notifications from routed namespace list", async () => {
    vi.useFakeTimers();
    const { mockBot, mockRedis, sent, listQueues } = buildMocks();

    const routedListKey = notifyListKey("simorgh");
    listQueues.set(routedListKey, [JSON.stringify({ text: "telegram only", routing: ["telegram"] })]);

    const handle = startNotifier(
      mockBot as never,
      null,
      "money-brain",
      mockRedis as never,
    );

    handle.registerRoutedChannelId("simorgh", "discord-ch-444");

    await vi.advanceTimersByTimeAsync(5_100);

    // routing: ["telegram"] excludes discord — nothing should be sent
    expect(sent).toHaveLength(0);
  });
});
