/**
 * DiscordNotifier — subscribes to Redis pub/sub channels and bridges messages to Discord.
 *
 * Channels:
 *   cca:notify:{namespace}        — job completion notifications from cc-agent → forward to DISCORD_NOTIFY_CHANNEL_ID
 *   cca:chat:incoming:{namespace} — messages from the web UI → echo to Discord + feed into Claude session
 *   cca:chat:outgoing:*           — meta-agent stdout lines (source=claude) → buffer+debounce → Discord
 *
 * All messages (Discord incoming, Claude responses) are also written to:
 *   cca:chat:log:{namespace}      — LPUSH + LTRIM 0 499 (last 500 messages)
 *   cca:chat:outgoing:{namespace} — PUBLISH for web UI to consume
 */

import { Redis } from "ioredis";
import {
  chatLogKey,
  chatOutgoingChannel,
  chatIncomingChannel,
  notifyChannel,
  notifyListKey,
  metaAgentStatusKey,
  metaInputKey,
  type NotificationPayload,
  type Transport,
} from "@gonzih/cc-wire";
import { splitLongMessage, stripAnsi } from "./formatter.js";
import type { CcDiscordBot } from "./bot.js";

export interface ChatMessage {
  id: string;
  source: "discord" | "ui" | "claude" | "cc-tg";
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: string;
  chatId: number;
}

function log(level: "info" | "warn" | "error", ...args: unknown[]): void {
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn("[notifier]", ...args);
}

/**
 * Shorten a model name for display in a badge.
 */
function shortenModelName(model: string, driver: string): string {
  if (!model.trim()) return "";
  const pfx = driver.toLowerCase() + "-";
  if (model.toLowerCase().startsWith(pfx)) return model.slice(pfx.length);
  const slashIdx = model.indexOf("/");
  if (slashIdx >= 0) return model.slice(slashIdx + 1);
  return model;
}

export interface ParsedNotification {
  text: string;
  chatId?: number;
}

/**
 * Parse a notification payload.
 * Returns the display text plus an optional chatId for per-channel routing,
 * or null when the routing array excludes "discord".
 * Appends a [driver] or [driver:model] badge when present.
 * Appends " cost: $X.XXX" if a numeric cost field is present.
 */
export function parseNotification(raw: string): ParsedNotification | null {
  let text = raw;
  let driver: string | undefined;
  let model: string | undefined;
  let cost: number | undefined;
  let chatId: number | undefined;
  try {
    const parsed = JSON.parse(raw) as NotificationPayload;
    // routing: absent/empty → all transports; non-empty → only listed transports
    if (parsed.routing && parsed.routing.length > 0 && !parsed.routing.includes("discord" as Transport)) {
      return null;
    }
    if (parsed.text) text = parsed.text;
    driver = parsed.driver;
    model = parsed.model;
    if (typeof parsed.cost === "number") cost = parsed.cost;
    if (typeof parsed.chat_id === "number" && parsed.chat_id !== 0) chatId = parsed.chat_id;
  } catch {
    return { text };
  }

  if (!driver) return { text, chatId };

  const shortModel = shortenModelName(model ?? "", driver);
  const badge = shortModel ? `${driver}:${shortModel}` : driver;
  const costStr = cost != null ? ` cost: $${cost.toFixed(3)}` : "";
  return { text: `${text}\n[${badge}]${costStr}`, chatId };
}

/**
 * Write a message to the chat log in Redis.
 * Fire-and-forget — errors are logged but not thrown.
 */
export function writeChatLog(
  redis: Redis,
  namespace: string,
  msg: ChatMessage
): void {
  const logKey = chatLogKey(namespace);
  const outKey = chatOutgoingChannel(namespace);
  const payload = JSON.stringify(msg);
  redis.lpush(logKey, payload).catch((err: Error) => {
    log("warn", "writeChatLog lpush failed:", err.message);
  });
  redis.ltrim(logKey, 0, 499).catch((err: Error) => {
    log("warn", "writeChatLog ltrim failed:", err.message);
  });
  redis.publish(outKey, payload).catch((err: Error) => {
    log("warn", "writeChatLog publish failed:", err.message);
  });
}

/**
 * Resolve the target Discord channelId for a notification.
 * When chatId is set and a reverse-lookup function is available, prefer the originating channel.
 * Falls back to notifyChannelId, then getActiveChannelId.
 */
function resolveNotifyChannel(
  chatId: number | undefined,
  notifyChannelId: string | null,
  getActiveChannelId?: () => string | undefined,
  reverseSnowflakeLookup?: (n: number) => string | undefined
): string | undefined {
  if (chatId != null && reverseSnowflakeLookup) {
    const resolved = reverseSnowflakeLookup(chatId);
    if (resolved) return resolved;
  }
  return notifyChannelId ?? getActiveChannelId?.();
}

export interface NotifierHandle {
  /**
   * Register the originating Discord channel ID for a routed namespace.
   * When the meta-agent for `namespace` publishes a response, it will be
   * forwarded to `channelId`.
   */
  registerRoutedChannelId: (namespace: string, channelId: string) => void;
}

/**
 * Start the Discord notifier.
 *
 * @param bot                     - CcDiscordBot instance (for sending messages)
 * @param notifyChannelId         - Discord channel ID to forward notifications to. Pass null to use getActiveChannelId.
 * @param namespace               - cc-agent namespace (used to build Redis channel names)
 * @param redis                   - ioredis client in normal mode (will be duplicated for pub/sub)
 * @param handleUserMessage       - Optional callback to feed UI messages into the active Claude session
 * @param forwardNotification     - Optional callback to forward job notifications
 * @param getActiveChannelId      - Optional callback to resolve channelId dynamically
 * @param reverseSnowflakeLookup  - Optional callback to resolve a chatId integer to a Discord channelId
 */
export function startNotifier(
  bot: CcDiscordBot,
  notifyChannelId: string | null,
  namespace: string,
  redis: Redis,
  handleUserMessage?: (channelId: string, text: string) => void,
  forwardNotification?: (channelId: string, text: string) => void,
  getActiveChannelId?: () => string | undefined,
  reverseSnowflakeLookup?: (n: number) => string | undefined
): NotifierHandle {
  // Per-namespace channelId registry
  const routedChannelIds = new Map<string, string>();

  const sub = redis.duplicate({
    retryStrategy: (times: number) => {
      const delay = Math.min(1000 * Math.pow(2, times - 1), 30_000);
      log("info", `subscriber reconnecting in ${delay}ms (attempt ${times})`);
      return delay;
    },
  });

  sub.on("error", (err: Error) => {
    log("warn", "subscriber error:", err.message);
  });

  sub.on("close", () => {
    log("info", "subscriber disconnected, will reconnect with backoff");
  });

  // notifyChannel(namespace) — forward job completion notifications to Discord
  sub.subscribe(notifyChannel(namespace), (err) => {
    if (err) {
      log("error", `subscribe ${notifyChannel(namespace)} failed:`, err.message);
    } else {
      log("info", `subscribed to ${notifyChannel(namespace)}`);
    }
  });

  // chatIncomingChannel(namespace) — messages from UI
  sub.subscribe(chatIncomingChannel(namespace), (err) => {
    if (err) {
      log("error", `subscribe ${chatIncomingChannel(namespace)} failed:`, err.message);
    } else {
      log("info", `subscribed to ${chatIncomingChannel(namespace)}`);
    }
  });

  // chatOutgoingChannel("*") — meta-agent stdout lines
  sub.psubscribe(chatOutgoingChannel("*"), (err) => {
    if (err) {
      log("error", `psubscribe ${chatOutgoingChannel("*")} failed:`, err.message);
    } else {
      log("info", `psubscribed to ${chatOutgoingChannel("*")}`);
    }
  });

  // 1.5s silence buffer for meta-agent streaming
  const META_AGENT_FLUSH_DELAY_MS = 1500;
  const metaAgentBuffers = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> | null }>();

  function flushMetaAgentBuffer(ns: string, targetChannelId: string): void {
    const buf = metaAgentBuffers.get(ns);
    if (!buf || !buf.text.trim()) return;
    const text = `← [${ns}] ` + stripAnsi(buf.text.trim());
    buf.text = "";
    buf.timer = null;
    const chunks = splitLongMessage(text);
    for (const chunk of chunks) {
      bot.sendToChannelById(targetChannelId, chunk).catch((err: Error) => {
        log("warn", `meta-agent flush sendToChannelById failed (ns=${ns}):`, err.message);
      });
    }
  }

  sub.on("pmessage", (pattern: string, channel: string, message: string) => {
    void pattern;
    const ns = channel.slice(chatOutgoingChannel("").length);

    let parsed: { source?: string; content?: string } | null = null;
    try {
      parsed = JSON.parse(message) as { source?: string; content?: string };
    } catch {
      return;
    }

    if (parsed.source !== "claude") return;
    const content = parsed.content;
    if (!content) return;

    const targetChannelId = routedChannelIds.get(ns) ?? notifyChannelId ?? getActiveChannelId?.();
    if (targetChannelId == null) {
      log("warn", `meta-agent output: no channelId for namespace=${ns}, dropping line`);
      return;
    }

    let buf = metaAgentBuffers.get(ns);
    if (!buf) {
      buf = { text: "", timer: null };
      metaAgentBuffers.set(ns, buf);
    }
    buf.text += (buf.text ? "\n" : "") + content;
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => flushMetaAgentBuffer(ns, targetChannelId), META_AGENT_FLUSH_DELAY_MS);
  });

  // Poll the notifyListKey(namespace) LIST every 5 seconds
  const notifyListRedisKey = notifyListKey(namespace);
  const MAX_PER_CYCLE = 20;

  const pollNotifyList = async (): Promise<void> => {
    const targetId = notifyChannelId ?? getActiveChannelId?.();
    if (targetId == null) return;

    const items: string[] = [];
    try {
      for (let i = 0; i < MAX_PER_CYCLE; i++) {
        const item = await redis.rpop(notifyListRedisKey);
        if (item === null) break;
        items.push(item);
      }
    } catch (err) {
      log("warn", "notify list rpop failed:", (err as Error).message);
      return;
    }

    if (items.length === 0) return;

    let remaining = 0;
    if (items.length === MAX_PER_CYCLE) {
      try {
        remaining = await redis.llen(notifyListRedisKey);
      } catch (err) {
        log("warn", "notify list llen failed:", (err as Error).message);
      }
    }

    for (const raw of items) {
      const notification = parseNotification(raw);
      if (notification === null) continue; // routing excludes discord
      const destChannelId = resolveNotifyChannel(notification.chatId, notifyChannelId, getActiveChannelId, reverseSnowflakeLookup) ?? targetId;
      bot.sendToChannelById(destChannelId, notification.text).catch((err: Error) => {
        log("warn", "notify list send failed:", err.message);
      });
      if (forwardNotification) {
        forwardNotification(destChannelId, notification.text);
      }
    }

    if (remaining > 0) {
      bot.sendToChannelById(targetId, `...and ${remaining} more notifications`).catch((err: Error) => {
        log("warn", "notify list summary send failed:", err.message);
      });
    }
  };

  setInterval(() => {
    void pollNotifyList();
  }, 5_000);

  sub.on("message", (channel: string, message: string) => {
    const notifyCh = notifyChannel(namespace);
    const incomingCh = chatIncomingChannel(namespace);

    if (channel === notifyCh) {
      const notification = parseNotification(message);
      if (notification === null) return; // routing excludes discord
      const targetId = resolveNotifyChannel(notification.chatId, notifyChannelId, getActiveChannelId, reverseSnowflakeLookup);
      if (targetId != null) {
        bot.sendToChannelById(targetId, notification.text).catch((err: Error) => {
          log("warn", "notify send failed:", err.message);
        });
        if (forwardNotification) {
          forwardNotification(targetId, notification.text);
        }
      } else {
        log("warn", "notify: no channelId available, dropping notification");
      }
      return;
    }

    if (channel === incomingCh) {
      let content = message;
      let originalTimestamp: string | undefined;
      try {
        const parsed = JSON.parse(message) as { content?: string; timestamp?: string };
        if (parsed.content) content = parsed.content;
        if (parsed.timestamp) originalTimestamp = parsed.timestamp;
      } catch {
        // raw string message — use as-is
      }

      const targetChannelId = notifyChannelId ?? getActiveChannelId?.();

      if (targetChannelId !== undefined) {
        // Echo to Discord so the user sees UI messages
        bot.sendToChannelById(targetChannelId, `[from UI]: ${content}`).catch((err: Error) => {
          log("warn", "sendToChannelById (UI echo) failed:", err.message);
        });

        // Log the incoming message
        const inMsg: ChatMessage = {
          id: crypto.randomUUID(),
          source: "ui",
          role: "user",
          content,
          timestamp: originalTimestamp ?? new Date().toISOString(),
          chatId: 0, // no numeric chatId for Discord — stored by channelId string
        };
        writeChatLog(redis, namespace, inMsg);

        // Check if a meta-agent is running; if so, route there instead
        void (async () => {
          let routedToMetaAgent = false;
          try {
            const statusRaw = await redis.get(metaAgentStatusKey(namespace));
            if (statusRaw) {
              const status = JSON.parse(statusRaw) as { status?: string };
              if (status.status === "running") {
                const entry = JSON.stringify({
                  id: crypto.randomUUID(),
                  content,
                  timestamp: new Date().toISOString(),
                });
                await redis.rpush(metaInputKey(namespace), entry);
                log("info", `cca:chat:incoming: routed to meta-agent for namespace ${namespace}`);
                routedToMetaAgent = true;
              }
            }
          } catch (err) {
            log("warn", "meta-agent status check failed:", (err as Error).message);
          }

          if (!routedToMetaAgent && handleUserMessage) {
            handleUserMessage(targetChannelId, content);
          }
        })();
      } else {
        log("warn", "cca:chat:incoming: no active channelId to route message to");
      }
    }
  });

  return {
    registerRoutedChannelId: (ns: string, channelId: string) => {
      routedChannelIds.set(ns, channelId);
    },
  };
}
