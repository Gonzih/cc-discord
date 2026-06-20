/**
 * DiscordNotifier — subscribes to Redis pub/sub channels and bridges messages to Discord.
 *
 * v0.2.0 channels (discord-scoped):
 *   cca:discord:notify:{ns}              — job completion notifications → forward to Discord channel
 *   cca:chat:incoming:{ns}              — messages from the web UI → echo to Discord + feed to meta-agent
 *   cca:discord:chat:outgoing:{ns}      — meta-agent stdout lines (source=claude) → buffer+debounce → Discord
 *
 * All messages (Discord incoming, Claude responses) are also written to:
 *   cca:discord:chat:log:{ns}           — LPUSH + LTRIM 0 499 (last 500 messages)
 *   cca:discord:chat:outgoing:{ns}      — PUBLISH for web UI to consume
 */

import { Redis } from "ioredis";
import { createHash } from "crypto";
import {
  discordChatLog,
  discordChatOutgoing,
  discordNotify,
  notifyChannel,
  chatIncomingChannel,
  createCcWire,
  TIMING,
  dedupKey,
  type NotificationPayload,
  type Transport,
} from "@gonzih/cc-wire";
import { splitLongMessage, stripAnsi } from "./formatter.js";
/** Eval report from a meta-agent notification. */
export interface EvalReport {
  gate: string;
  passed: boolean;
  feedback: string;
  iteration: number;
  maxIterations: number;
  confidence: number;
}

/**
 * Parse an `eval_report` object embedded in a raw notification JSON string.
 * Returns null when the field is absent, malformed, or the input is not JSON.
 */
function parseEvalReport(raw: string): EvalReport | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const r = parsed.eval_report as Record<string, unknown> | undefined;
    if (!r || typeof r.gate !== "string" || typeof r.passed !== "boolean") return null;
    return {
      gate: r.gate,
      passed: r.passed,
      feedback: typeof r.feedback === "string" ? r.feedback : "",
      iteration: typeof r.iteration === "number" ? r.iteration : 0,
      maxIterations: typeof r.max_iterations === "number" ? r.max_iterations : 0,
      confidence: typeof r.confidence === "number" ? r.confidence : 0,
    };
  } catch {
    return null;
  }
}
import type { CcDiscordBot } from "./bot.js";

/** Compute a short stable dedup fingerprint for a raw notification string */
function notifFingerprint(raw: string): string {
  return createHash("sha256").update(raw.slice(0, 500)).digest("hex").slice(0, 16);
}

/**
 * Check whether this notification has already been forwarded for `ns` (Redis-backed dedup).
 * If not, records it (SADD + EXPIRE 120s) and returns false (not a dup).
 * Returns true if it's a duplicate and should be skipped.
 */
async function checkAndMarkSent(redis: Redis, ns: string, raw: string): Promise<boolean> {
  const key = dedupKey(ns);
  const fp = notifFingerprint(raw);
  // SADD returns 1 if the element was added (new), 0 if already existed (dup)
  const added = await redis.sadd(key, fp);
  if (added === 0) return true; // duplicate
  // Set/refresh the TTL on the set key
  await redis.expire(key, 120);
  return false;
}

/**
 * In-memory dedup cache for pub/sub notifications (avoids async overhead on hot path).
 * Maps fingerprint → expiry timestamp. Entries expire after 120 seconds.
 */
const inMemoryDedupCache = new Map<string, number>();
const IN_MEMORY_DEDUP_TTL_MS = 120_000;

function checkAndMarkSentSync(ns: string, raw: string): boolean {
  const fp = `${ns}:${notifFingerprint(raw)}`;
  const now = Date.now();
  // Evict expired entries (keep cache small)
  for (const [k, exp] of inMemoryDedupCache) {
    if (now > exp) inMemoryDedupCache.delete(k);
  }
  if (inMemoryDedupCache.has(fp)) return true; // duplicate
  inMemoryDedupCache.set(fp, now + IN_MEMORY_DEDUP_TTL_MS);
  return false;
}

export interface ChatMessage {
  id: string;
  source: "discord" | "ui" | "claude" | "cc-tg" | "cc-discord";
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
  isCron: boolean;
  /** Populated when the notification JSON contains an `eval_report` object. */
  evalReport?: EvalReport;
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
  let isCron = false;
  try {
    const parsed = JSON.parse(raw) as NotificationPayload & { is_cron?: boolean };
    // routing: absent/empty → all transports; non-empty → only listed transports
    if (parsed.routing && parsed.routing.length > 0 && !parsed.routing.includes("discord" as Transport)) {
      return null;
    }
    if (parsed.is_cron === true) return null;
    if (parsed.text) text = parsed.text;
    driver = parsed.driver;
    model = parsed.model;
    if (typeof parsed.cost === "number") cost = parsed.cost;
    if (typeof parsed.chat_id === "number" && parsed.chat_id !== 0) chatId = parsed.chat_id;
    if (typeof parsed.is_cron === "boolean") isCron = parsed.is_cron;
  } catch {
    // non-JSON: fall through to text-based check below
  }
  if (text.startsWith("⏰")) return null;

  // Parse eval_report if present — this field is non-standard and not in NotificationPayload type
  const evalReport = parseEvalReport(raw);

  if (!driver) return { text, chatId, isCron, evalReport: evalReport ?? undefined };

  const shortModel = shortenModelName(model ?? "", driver);
  const badge = shortModel ? `${driver}:${shortModel}` : driver;
  const costStr = cost != null ? ` cost: $${cost.toFixed(3)}` : "";
  return { text: `${text}\n[${badge}]${costStr}`, chatId, isCron, evalReport: evalReport ?? undefined };
}

/**
 * Write a message to the chat log in Redis.
 * Uses discord-scoped keys (cca:discord:chat:log:{ns}, cca:discord:chat:outgoing:{ns}).
 * Fire-and-forget — errors are logged but not thrown.
 */
export function writeChatLog(
  redis: Redis,
  namespace: string,
  msg: ChatMessage
): void {
  const logKey = discordChatLog(namespace);
  const outKey = discordChatOutgoing(namespace);
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
 * Priority:
 *   1. chatId → reverseSnowflakeLookup (originating channel from the notification payload)
 *   2. ns → getChannelIdForNamespace (registered Discord channel for this namespace)
 *   3. notifyChannelId (static env var — may be stale/dead)
 *   4. getActiveChannelId (last channel that sent a message)
 */
export function resolveNotifyChannel(
  chatId: number | undefined,
  notifyChannelId: string | null,
  getActiveChannelId?: () => string | undefined,
  reverseSnowflakeLookup?: (n: number) => string | undefined,
  ns?: string,
  getChannelIdForNamespace?: (ns: string) => string | undefined
): string | undefined {
  if (chatId != null && reverseSnowflakeLookup) {
    const resolved = reverseSnowflakeLookup(chatId);
    if (resolved) return resolved;
  }
  if (ns && getChannelIdForNamespace) {
    const resolved = getChannelIdForNamespace(ns);
    if (resolved) return resolved;
  }
  return notifyChannelId ?? getActiveChannelId?.();
}

export interface NotifierHandle {
  /**
   * Register the originating Discord channel ID for a routed namespace.
   * When the meta-agent for `namespace` publishes a response, it will be
   * forwarded to `channelId`.
   * Also subscribes to discordNotify(namespace) and chatIncomingChannel(namespace)
   * so notifications and UI messages for that namespace are received.
   */
  registerRoutedChannelId: (namespace: string, channelId: string) => void;
}

/**
 * Start the Discord notifier.
 *
 * @param bot                       - CcDiscordBot instance (for sending messages)
 * @param notifyChannelId           - Discord channel ID to forward notifications to. Pass null to use getActiveChannelId.
 * @param namespace                 - primary namespace (used to build Redis channel names)
 * @param redis                     - ioredis client in normal mode (will be duplicated for pub/sub)
 * @param handleUserMessage         - Optional callback to feed UI messages into the active Claude session
 * @param forwardNotification       - Optional callback to forward job notifications
 * @param getActiveChannelId        - Optional callback to resolve channelId dynamically
 * @param reverseSnowflakeLookup    - Optional callback to resolve a chatId integer to a Discord channelId
 * @param getChannelIdForNamespace  - Optional callback to resolve a namespace to its registered Discord channelId
 */
export function startNotifier(
  bot: CcDiscordBot,
  notifyChannelId: string | null,
  namespace: string,
  redis: Redis,
  handleUserMessage?: (channelId: string, text: string) => void,
  forwardNotification?: (channelId: string, text: string) => void,
  getActiveChannelId?: () => string | undefined,
  reverseSnowflakeLookup?: (n: number) => string | undefined,
  getChannelIdForNamespace?: (ns: string) => string | undefined
): NotifierHandle {
  const wire = createCcWire(redis);

  // Per-namespace channelId registry — maps routed namespace → Discord channelId
  const routedChannelIds = new Map<string, string>();
  // Track which namespaces we've already subscribed to (to avoid duplicate subscribe calls)
  const subscribedNamespaces = new Set<string>();

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

  // Reverse map: Redis channel string → namespace (for O(1) lookup in message handler)
  const channelToNamespace = new Map<string, string>();

  function subscribeNamespace(ns: string): void {
    if (subscribedNamespaces.has(ns)) return;
    subscribedNamespaces.add(ns);

    const notifyCh = discordNotify(ns);
    const legacyNotifyCh = notifyChannel(ns);
    const incomingCh = chatIncomingChannel(ns);
    channelToNamespace.set(notifyCh, ns);
    channelToNamespace.set(legacyNotifyCh, ns);
    channelToNamespace.set(incomingCh, ns);

    sub.subscribe(notifyCh, (err) => {
      if (err) {
        log("error", `subscribe ${notifyCh} failed:`, err.message);
      } else {
        log("info", `subscribed to ${notifyCh}`);
      }
    });

    sub.subscribe(legacyNotifyCh, (err) => {
      if (err) {
        log("error", `subscribe ${legacyNotifyCh} failed:`, err.message);
      } else {
        log("info", `subscribed to ${legacyNotifyCh}`);
      }
    });

    sub.subscribe(incomingCh, (err) => {
      if (err) {
        log("error", `subscribe ${incomingCh} failed:`, err.message);
      } else {
        log("info", `subscribed to ${incomingCh}`);
      }
    });
  }

  function resolveSubscribedNamespace(channel: string): string | undefined {
    return channelToNamespace.get(channel);
  }

  // Subscribe to the primary namespace immediately
  subscribeNamespace(namespace);

  // discordChatOutgoing("*") — meta-agent stdout lines for ALL discord namespaces
  const outgoingPattern = discordChatOutgoing("*");
  // Prefix to strip when extracting namespace from a matched channel name
  const outgoingPrefix = discordChatOutgoing("");

  sub.psubscribe(outgoingPattern, (err) => {
    if (err) {
      log("error", `psubscribe ${outgoingPattern} failed:`, err.message);
    } else {
      log("info", `psubscribed to ${outgoingPattern}`);
    }
  });

  // Buffer for meta-agent streaming output — debounced before sending to Discord
  const metaAgentBuffers = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> | null }>();

  function flushMetaAgentBuffer(ns: string, targetChannelId: string): void {
    const loopThreadId = bot.getLoopThreadId(targetChannelId);
    bot.stopMetaAgentTyping(loopThreadId ?? targetChannelId);
    const buf = metaAgentBuffers.get(ns);
    if (!buf || !buf.text.trim()) return;
    const text = `← [${ns}] ` + stripAnsi(buf.text.trim());
    if (text.length < 30) { buf.text = ""; buf.timer = null; return; }
    buf.text = "";
    buf.timer = null;
    // During an active loop, route meta-agent output to the thread rather than main channel
    const deliverTo = bot.getLoopThreadId(targetChannelId) ?? targetChannelId;
    const chunks = splitLongMessage(text);
    for (const chunk of chunks) {
      bot.sendWithFileDetection(deliverTo, chunk).catch((err: Error) => {
        log("warn", `meta-agent flush sendWithFileDetection failed (ns=${ns}):`, err.message);
      });
    }
  }

  sub.on("pmessage", (pattern: string, channel: string, message: string) => {
    void pattern;
    const ns = channel.slice(outgoingPrefix.length);

    let parsed: { source?: string; content?: string } | null = null;
    try {
      parsed = JSON.parse(message) as { source?: string; content?: string };
    } catch {
      return;
    }

    if (parsed.source !== "claude") return;
    const content = parsed.content;
    if (!content) return;

    // For the primary namespace: deliver to the primary Discord channel.
    // For other (routed) namespaces: only deliver to explicitly registered channelIds.
    const targetChannelId = routedChannelIds.get(ns) ??
      (ns === namespace ? (notifyChannelId ?? getActiveChannelId?.()) : undefined);

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
    buf.timer = setTimeout(
      () => flushMetaAgentBuffer(ns, targetChannelId),
      TIMING.META_AGENT_FLUSH_DELAY_MS
    );
  });

  // Poll discordNotify(ns) LIST every 5 seconds — covers primary + all routed namespaces.
  const MAX_PER_CYCLE = 20;

  const pollOneNamespace = async (ns: string, targetChannelId: string): Promise<void> => {
    const listKey = discordNotify(ns);
    const items: string[] = [];
    try {
      for (let i = 0; i < MAX_PER_CYCLE; i++) {
        const item = await redis.rpop(listKey);
        if (item === null) break;
        items.push(item);
      }
    } catch (err) {
      log("warn", `notify list rpop failed (ns=${ns}):`, (err as Error).message);
      return;
    }

    if (items.length === 0) return;

    let remaining = 0;
    if (items.length === MAX_PER_CYCLE) {
      try {
        remaining = await redis.llen(listKey);
      } catch (err) {
        log("warn", `notify list llen failed (ns=${ns}):`, (err as Error).message);
      }
    }

    for (const raw of items) {
      const notification = parseNotification(raw);
      if (notification === null) continue; // routing excludes discord

      // Dedup: skip if this notification was already forwarded recently
      // Uses Redis when available; falls back to in-memory dedup on Redis errors.
      let isDup = false;
      try {
        if (typeof (redis as unknown as Record<string, unknown>).sadd === "function") {
          isDup = await checkAndMarkSent(redis, ns, raw);
        } else {
          isDup = checkAndMarkSentSync(ns, raw);
        }
      } catch (err) {
        log("warn", `dedup check failed (ns=${ns}), falling back to in-memory:`, (err as Error).message);
        isDup = checkAndMarkSentSync(ns, raw);
      }
      if (isDup) {
        log("info", `dedup: skipping already-sent notification (ns=${ns})`);
        continue;
      }

      // Primary namespace: honour chatId-based per-channel routing via reverseSnowflakeLookup,
      // then namespace → channelId lookup, then notifyChannelId / active channel.
      // Routed namespaces: always deliver to the registered Discord channelId — no leakage.
      const mainChannelId = ns === namespace
        ? (resolveNotifyChannel(notification.chatId, notifyChannelId, getActiveChannelId, reverseSnowflakeLookup, ns, getChannelIdForNamespace) ?? targetChannelId)
        : targetChannelId;
      // If a loop is active for this channel, route to its thread (skip for cron notifications)
      const destChannelId = (!notification.isCron && bot.getLoopThreadId(mainChannelId)) ? bot.getLoopThreadId(mainChannelId)! : mainChannelId;
      // When an eval report is embedded, post a structured embed to the thread
      if (notification.evalReport) {
        bot.postEvalEmbed(mainChannelId, notification.evalReport).catch((err: Error) => {
          log("warn", `postEvalEmbed failed (ns=${ns}):`, err.message);
        });
      }
      bot.sendToChannelById(destChannelId, notification.text).catch((err: Error) => {
        log("warn", `notify list send failed (ns=${ns}):`, err.message);
      });
      if (!notification.isCron && handleUserMessage) {
        handleUserMessage(mainChannelId, notification.text);
      }
    }

    if (remaining > 0) {
      bot.sendToChannelById(targetChannelId, `...and ${remaining} more notifications`).catch((err: Error) => {
        log("warn", `notify list summary send failed (ns=${ns}):`, err.message);
      });
    }
  };

  const pollNotifyList = async (): Promise<void> => {
    // Primary namespace: prefer registered channel for this namespace, then env var, then active channel
    const primaryTargetId = getChannelIdForNamespace?.(namespace) ?? notifyChannelId ?? getActiveChannelId?.();
    if (primaryTargetId != null) {
      await pollOneNamespace(namespace, primaryTargetId);
    }
    // All registered routed namespaces
    for (const [ns, channelId] of routedChannelIds) {
      if (ns !== namespace) {
        await pollOneNamespace(ns, channelId);
      }
    }
  };

  setInterval(() => {
    void pollNotifyList();
  }, 5_000);

  sub.on("message", (channel: string, message: string) => {
    // Determine which namespace this channel belongs to
    const ns = resolveSubscribedNamespace(channel);
    if (!ns) return;

    const isPrimary = ns === namespace;
    const notifyCh = discordNotify(ns);
    const legacyNotifyCh = notifyChannel(ns);
    const incomingCh = chatIncomingChannel(ns);

    if (channel === notifyCh || channel === legacyNotifyCh) {
      const notification = parseNotification(message);
      if (notification === null) return; // routing excludes discord

      // Synchronous in-memory dedup — keeps pub/sub handler synchronous
      if (checkAndMarkSentSync(ns, message)) {
        log("info", `dedup: skipping already-sent pub/sub notification (ns=${ns})`);
        return;
      }

      let mainChannelId: string | undefined;
      if (isPrimary) {
        mainChannelId = resolveNotifyChannel(notification.chatId, notifyChannelId, getActiveChannelId, reverseSnowflakeLookup, ns, getChannelIdForNamespace);
      } else {
        // For routed namespaces, only use the registered channelId — no fallback to primary
        mainChannelId = notification.chatId != null && reverseSnowflakeLookup
          ? (reverseSnowflakeLookup(notification.chatId) ?? routedChannelIds.get(ns))
          : routedChannelIds.get(ns);
      }
      if (mainChannelId != null) {
        // If a loop is active, route notification text to the thread (skip for cron notifications)
        const deliverTo = (!notification.isCron && bot.getLoopThreadId(mainChannelId)) ? bot.getLoopThreadId(mainChannelId)! : mainChannelId;
        if (notification.evalReport) {
          bot.postEvalEmbed(mainChannelId, notification.evalReport).catch((err: Error) => {
            log("warn", `postEvalEmbed failed (ns=${ns}):`, err.message);
          });
        }
        bot.sendToChannelById(deliverTo, notification.text).catch((err: Error) => {
          log("warn", `notify send failed (ns=${ns}):`, err.message);
        });
        if (!notification.isCron && handleUserMessage) {
          handleUserMessage(mainChannelId, notification.text);
        }
      } else {
        log("warn", `notify: no channelId available for ns=${ns}, dropping notification`);
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

      const targetChannelId = isPrimary
        ? (notifyChannelId ?? getActiveChannelId?.())
        : routedChannelIds.get(ns);

      if (targetChannelId !== undefined) {
        // Echo to Discord so the user sees UI messages
        bot.sendToChannelById(targetChannelId, `[from UI]: ${content}`).catch((err: Error) => {
          log("warn", `sendToChannelById (UI echo) failed (ns=${ns}):`, err.message);
        });

        // Log the incoming message
        const inMsg: ChatMessage = {
          id: crypto.randomUUID(),
          source: "ui",
          role: "user",
          content,
          timestamp: originalTimestamp ?? new Date().toISOString(),
          chatId: 0,
        };
        writeChatLog(redis, ns, inMsg);

        // Route to meta-agent input queue if this namespace has a registered session;
        // otherwise fall through to handleUserMessage (local Claude session).
        void (async () => {
          let routedToMetaAgent = false;

          if (routedChannelIds.has(ns)) {
            try {
              const status = await wire.discord.getStatus(ns);
              if (status && (status.status === "running" || status.status === "idle")) {
                await wire.discord.enqueue(ns, {
                  id: crypto.randomUUID(),
                  source: "ui",
                  role: "user",
                  content,
                  timestamp: new Date().toISOString(),
                });
                log("info", `cca:chat:incoming: routed to meta-agent for namespace ${ns}`);
                routedToMetaAgent = true;
              }
            } catch (err) {
              log("warn", `meta-agent status check failed (ns=${ns}):`, (err as Error).message);
            }
          }

          if (!routedToMetaAgent && handleUserMessage) {
            handleUserMessage(targetChannelId, content);
          }
        })();
      } else {
        log("warn", `cca:chat:incoming: no active channelId for ns=${ns}, dropping message`);
      }
    }
  });

  return {
    registerRoutedChannelId: (ns: string, channelId: string) => {
      routedChannelIds.set(ns, channelId);
      // Subscribe to this namespace's Redis channels so we receive its notifications
      // and incoming UI messages. No-op if already subscribed.
      subscribeNamespace(ns);
    },
  };
}
