import { describe, it, expect, vi, afterEach } from "vitest";
import { parseNotification, resolveNotifyChannel, startNotifier } from "./notifier.js";
import { discordNotify, discordChatOutgoing, notifyChannel } from "@gonzih/cc-wire";

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

  it("uses getChannelIdForNamespace when ns is provided", () => {
    const lookup = (_ns: string) => "ns-channel";
    expect(resolveNotifyChannel(undefined, "notify-channel", undefined, undefined, "my-ns", lookup)).toBe("ns-channel");
  });

  it("prefers getChannelIdForNamespace over notifyChannelId", () => {
    const lookup = (_ns: string) => "ns-channel";
    expect(resolveNotifyChannel(undefined, "dead-notify-ch", undefined, undefined, "my-ns", lookup)).toBe("ns-channel");
  });

  it("still falls back to notifyChannelId when getChannelIdForNamespace returns undefined", () => {
    const lookup = (_ns: string) => undefined;
    expect(resolveNotifyChannel(undefined, "notify-channel", undefined, undefined, "my-ns", lookup)).toBe("notify-channel");
  });

  it("reverseSnowflakeLookup takes priority over getChannelIdForNamespace", () => {
    const snowflakeLookup = (n: number) => (n === 42 ? "channel-42" : undefined);
    const nsLookup = (_ns: string) => "ns-channel";
    expect(resolveNotifyChannel(42, "notify-channel", undefined, snowflakeLookup, "my-ns", nsLookup)).toBe("channel-42");
  });
});

describe("parseNotification", () => {
  it("returns raw string when not JSON", () => {
    expect(parseNotification("plain text")).toMatchObject({ text: "plain text" });
  });

  it("extracts text from JSON payload", () => {
    const payload = JSON.stringify({ text: "job done" });
    expect(parseNotification(payload)).toMatchObject({ text: "job done" });
  });

  it("appends driver badge when driver is present", () => {
    const payload = JSON.stringify({ text: "done", driver: "claude" });
    expect(parseNotification(payload)).toMatchObject({ text: "done\n[claude]" });
  });

  it("appends driver:model badge when both present", () => {
    const payload = JSON.stringify({ text: "done", driver: "claude", model: "claude-sonnet-4-6" });
    expect(parseNotification(payload)).toMatchObject({ text: "done\n[claude:sonnet-4-6]" });
  });

  it("appends cost when numeric cost present", () => {
    const payload = JSON.stringify({ text: "done", driver: "claude", cost: 0.123 });
    expect(parseNotification(payload)).toMatchObject({ text: "done\n[claude] cost: $0.123" });
  });

  it("strips vendor prefix from openrouter-style model names", () => {
    const payload = JSON.stringify({ text: "done", driver: "openrouter", model: "openai/gpt-4o" });
    expect(parseNotification(payload)).toMatchObject({ text: "done\n[openrouter:gpt-4o]" });
  });

  it("returns text unchanged when no driver", () => {
    const payload = JSON.stringify({ text: "just text", model: "gpt-4" });
    expect(parseNotification(payload)).toMatchObject({ text: "just text" });
  });

  it("extracts chat_id from JSON payload", () => {
    const payload = JSON.stringify({ text: "job done", chat_id: 12345 });
    expect(parseNotification(payload)).toMatchObject({ text: "job done", chatId: 12345 });
  });

  it("ignores zero chat_id", () => {
    const payload = JSON.stringify({ text: "job done", chat_id: 0 });
    expect(parseNotification(payload)).toMatchObject({ text: "job done" });
    expect(parseNotification(JSON.stringify({ text: "job done", chat_id: 0 }))?.chatId).toBeUndefined();
  });

  it("extracts chat_id alongside driver badge", () => {
    const payload = JSON.stringify({ text: "done", driver: "claude", chat_id: 99 });
    expect(parseNotification(payload)).toMatchObject({ text: "done\n[claude]", chatId: 99 });
  });

  it("returns null when routing excludes discord", () => {
    const payload = JSON.stringify({ text: "done", routing: ["telegram"] });
    expect(parseNotification(payload)).toBeNull();
  });

  it("returns null when is_cron is true", () => {
    const payload = JSON.stringify({ text: "heartbeat", is_cron: true });
    expect(parseNotification(payload)).toBeNull();
  });

  it("delivers when routing includes discord", () => {
    const payload = JSON.stringify({ text: "done", routing: ["discord"] });
    expect(parseNotification(payload)).toMatchObject({ text: "done" });
  });

  it("delivers when routing includes discord alongside other transports", () => {
    const payload = JSON.stringify({ text: "done", routing: ["discord", "telegram"] });
    expect(parseNotification(payload)).toMatchObject({ text: "done" });
  });

  it("delivers when routing is absent", () => {
    const payload = JSON.stringify({ text: "done" });
    expect(parseNotification(payload)).toMatchObject({ text: "done" });
  });

  it("delivers when routing is an empty array", () => {
    const payload = JSON.stringify({ text: "done", routing: [] });
    expect(parseNotification(payload)).toMatchObject({ text: "done" });
  });

  it("delivers cron=false notifications normally", () => {
    const payload = JSON.stringify({ text: "job complete", is_cron: false });
    expect(parseNotification(payload)).toMatchObject({ text: "job complete", isCron: false });
  });
});

/** Build the minimal mocks needed to call startNotifier without a real Redis or Discord client. */
function buildMocks(loopThreadMap?: Map<string, string>) {
  // Track messages sent by the bot
  const sent: Array<{ channelId: string; text: string }> = [];
  const stoppedTyping: string[] = [];
  const evalEmbeds: Array<{ channelId: string; report: unknown }> = [];
  const mockBot = {
    sendToChannelById: vi.fn((channelId: string, text: string) => {
      sent.push({ channelId, text });
      return Promise.resolve();
    }),
    sendWithFileDetection: vi.fn((channelId: string, text: string) => {
      sent.push({ channelId, text });
      return Promise.resolve();
    }),
    stopMetaAgentTyping: vi.fn((channelId: string) => {
      stoppedTyping.push(channelId);
    }),
    getLoopThreadId: vi.fn((channelId: string) => loopThreadMap?.get(channelId)),
    postEvalEmbed: vi.fn((channelId: string, report: unknown) => {
      evalEmbeds.push({ channelId, report });
      return Promise.resolve();
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
    // pipeline mock for createCcWire usage inside startNotifier
    pipeline: vi.fn(() => ({
      publish: vi.fn().mockReturnThis(),
      lpush: vi.fn().mockReturnThis(),
      ltrim: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    })),
    // wire.discord.getStatus used in chat-incoming routing
    get: vi.fn().mockResolvedValue(null),
    // wire.discord.enqueue used when routing to meta-agent
    rpush: vi.fn().mockResolvedValue(1),
    // wire.token.getMaster fallback
    hgetall: vi.fn().mockResolvedValue(null),
    smembers: vi.fn().mockResolvedValue([]),
  };

  return { mockBot, mockSub, mockRedis, sent, stoppedTyping, evalEmbeds, listQueues };
}

describe("startNotifier — pmessage (cca:discord:chat:outgoing:*)", () => {
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

    const msg = JSON.stringify({ source: "claude", content: "Running the analysis as requested" });
    mockSub.emit("pmessage", discordChatOutgoing("*"), discordChatOutgoing("money-brain"), msg);

    await vi.advanceTimersByTimeAsync(2_000);

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

    const msg = JSON.stringify({ source: "claude", content: "Running the requested task for this namespace" });
    mockSub.emit("pmessage", discordChatOutgoing("*"), discordChatOutgoing("simorgh"), msg);

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
    mockSub.emit("pmessage", discordChatOutgoing("*"), discordChatOutgoing("simorgh"), msg);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(stoppedTyping).toContain("discord-ch-888");
  });
});

describe("startNotifier — per-namespace list polling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls discordNotify list for routed namespaces after registerRoutedChannelId", async () => {
    vi.useFakeTimers();
    const { mockBot, mockRedis, sent, listQueues } = buildMocks();

    const routedListKey = discordNotify("simorgh");
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

    const routedListKey = discordNotify("simorgh");
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

    const primaryListKey = discordNotify("money-brain");
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

  it("routes primary-namespace notifications to getChannelIdForNamespace result, ignoring notifyChannelId", async () => {
    vi.useFakeTimers();
    const { mockBot, mockRedis, sent, listQueues } = buildMocks();

    const primaryListKey = discordNotify("money-brain");
    listQueues.set(primaryListKey, [JSON.stringify({ text: "namespace routed" })]);

    startNotifier(
      mockBot as never,
      "dead-notify-ch",         // would be sent here without the namespace lookup
      "money-brain",
      mockRedis as never,
      undefined,
      undefined,
      undefined,
      undefined,
      (_ns) => "correct-ns-channel",  // getChannelIdForNamespace
    );

    await vi.advanceTimersByTimeAsync(5_100);

    expect(sent).toContainEqual({ channelId: "correct-ns-channel", text: "namespace routed" });
    expect(sent.every((m) => m.channelId !== "dead-notify-ch")).toBe(true);
  });

  it("skips routing-excluded notifications from routed namespace list", async () => {
    vi.useFakeTimers();
    const { mockBot, mockRedis, sent, listQueues } = buildMocks();

    const routedListKey = discordNotify("simorgh");
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

describe("startNotifier — legacy notifyChannel (cca:notify:{ns}) pub/sub", () => {
  it("subscribes to legacy cca:notify:{ns} channel", () => {
    const { mockBot, mockSub, mockRedis } = buildMocks();

    startNotifier(
      mockBot as never,
      "primary-notify-ch",
      "money-brain",
      mockRedis as never,
    );

    const subscribed = mockSub.subscribe.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(subscribed).toContain(notifyChannel("money-brain"));
  });

  it("handles messages on legacy cca:notify:{ns} channel and delivers to notifyChannelId", () => {
    const { mockBot, mockSub, mockRedis, sent } = buildMocks();

    startNotifier(
      mockBot as never,
      "primary-notify-ch",
      "money-brain",
      mockRedis as never,
    );

    mockSub.emit("message", notifyChannel("money-brain"), JSON.stringify({ text: "legacy job done" }));

    expect(sent).toContainEqual({ channelId: "primary-notify-ch", text: "legacy job done" });
  });

  it("handles messages on legacy channel and uses getChannelIdForNamespace over notifyChannelId", () => {
    const { mockBot, mockSub, mockRedis, sent } = buildMocks();

    startNotifier(
      mockBot as never,
      "dead-notify-ch",
      "money-brain",
      mockRedis as never,
      undefined,
      undefined,
      undefined,
      undefined,
      (_ns) => "correct-ns-channel",
    );

    mockSub.emit("message", notifyChannel("money-brain"), JSON.stringify({ text: "legacy via namespace" }));

    expect(sent).toContainEqual({ channelId: "correct-ns-channel", text: "legacy via namespace" });
    expect(sent.every((m) => m.channelId !== "dead-notify-ch")).toBe(true);
  });

  it("delivers legacy channel notification to the Discord channel", () => {
    const { mockBot, mockSub, mockRedis, sent } = buildMocks();

    startNotifier(
      mockBot as never,
      "primary-notify-ch",
      "money-brain",
      mockRedis as never,
    );

    mockSub.emit("message", notifyChannel("money-brain"), "legacy plain text");

    expect(sent).toContainEqual({ channelId: "primary-notify-ch", text: "legacy plain text" });
  });
});

describe("parseNotification — eval_report", () => {
  it("returns evalReport when eval_report present in JSON payload", () => {
    const raw = JSON.stringify({
      text: "Gate check",
      eval_report: { gate: "completion", passed: true, feedback: "done", iteration: 1, max_iterations: 5, confidence: 0.9 },
    });
    const result = parseNotification(raw);
    expect(result?.evalReport).toMatchObject({ gate: "completion", passed: true, confidence: 0.9 });
  });

  it("returns evalReport=undefined when no eval_report in payload", () => {
    const raw = JSON.stringify({ text: "just a notification" });
    const result = parseNotification(raw);
    expect(result?.evalReport).toBeUndefined();
  });

  it("returns evalReport=undefined for plain text (non-JSON) notifications", () => {
    const result = parseNotification("plain text message");
    expect(result?.evalReport).toBeUndefined();
  });
});

describe("startNotifier — loop thread routing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("routes notify list messages to the loop thread when getLoopThreadId returns a thread", async () => {
    vi.useFakeTimers();
    // Map primary channel → thread
    const loopThreadMap = new Map([["primary-notify-ch", "thread-id-123"]]);
    const { mockBot, mockRedis, sent, listQueues } = buildMocks(loopThreadMap);

    const primaryListKey = discordNotify("money-brain");
    listQueues.set(primaryListKey, [JSON.stringify({ text: "loop iteration output" })]);

    startNotifier(
      mockBot as never,
      "primary-notify-ch",
      "money-brain",
      mockRedis as never,
    );

    await vi.advanceTimersByTimeAsync(5_100);

    // Should deliver to the thread, not the main channel
    expect(sent).toContainEqual({ channelId: "thread-id-123", text: "loop iteration output" });
    expect(sent.every((m) => m.channelId !== "primary-notify-ch")).toBe(true);
  });

  it("posts eval embed when notification contains eval_report", async () => {
    vi.useFakeTimers();
    const { mockBot, mockRedis, evalEmbeds, listQueues } = buildMocks();

    const primaryListKey = discordNotify("money-brain");
    listQueues.set(primaryListKey, [
      JSON.stringify({
        text: "Gate check",
        eval_report: { gate: "quality", passed: false, feedback: "needs work", iteration: 2, max_iterations: 5, confidence: 0.4 },
      }),
    ]);

    startNotifier(
      mockBot as never,
      "primary-notify-ch",
      "money-brain",
      mockRedis as never,
    );

    await vi.advanceTimersByTimeAsync(5_100);

    expect(evalEmbeds).toHaveLength(1);
    expect(evalEmbeds[0]).toMatchObject({
      channelId: "primary-notify-ch",
      report: expect.objectContaining({ gate: "quality", passed: false }),
    });
  });

  it("routes pubsub notify messages to loop thread when getLoopThreadId returns thread", () => {
    const loopThreadMap = new Map([["primary-notify-ch", "thread-pubsub-456"]]);
    const { mockBot, mockSub, mockRedis, sent } = buildMocks(loopThreadMap);

    startNotifier(
      mockBot as never,
      "primary-notify-ch",
      "money-brain",
      mockRedis as never,
    );

    mockSub.emit("message", discordNotify("money-brain"), JSON.stringify({ text: "pubsub loop output" }));

    expect(sent).toContainEqual({ channelId: "thread-pubsub-456", text: "pubsub loop output" });
  });

  it("routes meta-agent buffer to loop thread in flushMetaAgentBuffer", async () => {
    vi.useFakeTimers();
    const loopThreadMap = new Map([["primary-notify-ch", "thread-meta-789"]]);
    const { mockBot, mockSub, mockRedis, sent } = buildMocks(loopThreadMap);

    startNotifier(
      mockBot as never,
      "primary-notify-ch",
      "money-brain",
      mockRedis as never,
    );

    const msg = JSON.stringify({ source: "claude", content: "loop step output" });
    mockSub.emit("pmessage", discordChatOutgoing("*"), discordChatOutgoing("money-brain"), msg);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(sent).toContainEqual(expect.objectContaining({ channelId: "thread-meta-789" }));
    expect(sent.every((m) => m.channelId !== "primary-notify-ch")).toBe(true);
  });

  it("suppresses meta-agent buffer flush when total text is under 30 chars", async () => {
    vi.useFakeTimers();
    const { mockBot, mockSub, mockRedis, sent } = buildMocks();

    startNotifier(
      mockBot as never,
      "primary-notify-ch",
      "money-brain",
      mockRedis as never,
    );

    // "OK." → "← [money-brain] OK." = 19 chars < 30 — should be suppressed
    const msg = JSON.stringify({ source: "claude", content: "OK." });
    mockSub.emit("pmessage", discordChatOutgoing("*"), discordChatOutgoing("money-brain"), msg);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(sent).toHaveLength(0);
  });
});
