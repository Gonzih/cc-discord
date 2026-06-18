#!/usr/bin/env node
/**
 * cc-discord — Claude Code Discord bot
 *
 * Usage:
 *   npx @gonzih/cc-discord
 *
 * Required env:
 *   DISCORD_BOT_TOKEN          — from Discord Developer Portal
 *   CLAUDE_CODE_OAUTH_TOKEN    — your Claude Code OAuth token (or ANTHROPIC_API_KEY)
 *
 * Optional env:
 *   DISCORD_GUILD_IDS          — comma-separated Discord guild/server IDs (for instant slash command registration)
 *   DISCORD_ALLOWED_USER_IDS   — comma-separated Discord user IDs to whitelist (leave empty to allow all)
 *   DISCORD_NOTIFY_CHANNEL_ID  — Discord channel ID for job notifications
 *   CC_AGENT_NAMESPACE         — primary namespace (default: money-brain)
 *   REDIS_URL                  — Redis connection URL (default: redis://localhost:6379)
 *   CWD                        — working directory for Claude Code (default: process.cwd())
 *   DEFAULT_GITHUB_ORG         — default GitHub org for #repo routing (default: gonzih)
 *   CC_DISCORD_MCP_JSON        — JSON template for .mcp.json injection into workspaces
 */

import { createRequire } from "node:module";
import { randomUUID } from "crypto";
import { Redis } from "ioredis";
import { createCcWire } from "@gonzih/cc-wire";
import { CcDiscordBot } from "./bot.js";
import { startNotifier } from "./notifier.js";
import { loadTokens } from "./tokens.js";
import { migrateMetaInputKeys } from "./meta-agent-manager.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

function required(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`
ERROR: ${name} is not set.

cc-discord requires:
  DISCORD_BOT_TOKEN         — create a bot at https://discord.com/developers/applications
  CLAUDE_CODE_OAUTH_TOKEN   — your Claude Code OAuth token

Set them and run again:
  DISCORD_BOT_TOKEN=xxx CLAUDE_CODE_OAUTH_TOKEN=yyy npx @gonzih/cc-discord
`);
    process.exit(1);
  }
  return val;
}

const discordToken = required("DISCORD_BOT_TOKEN");

const claudeToken =
  process.env.CLAUDE_CODE_TOKEN ??
  process.env.CLAUDE_CODE_OAUTH_TOKEN ??
  process.env.ANTHROPIC_API_KEY;

if (!claudeToken) {
  console.error(`
ERROR: No Claude token set. Set one of: CLAUDE_CODE_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, or ANTHROPIC_API_KEY.
`);
  process.exit(1);
}

// Load OAuth token pool
const tokenPool = loadTokens();
if (tokenPool.length > 1) {
  console.log(`[cc-discord] Token pool loaded: ${tokenPool.length} tokens`);
}

const guildIds = process.env.DISCORD_GUILD_IDS
  ? process.env.DISCORD_GUILD_IDS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

const allowedUserIds = process.env.DISCORD_ALLOWED_USER_IDS
  ? process.env.DISCORD_ALLOWED_USER_IDS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

const cwd = process.env.CWD ?? process.cwd();
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const namespace = process.env.CC_AGENT_NAMESPACE || "money-brain";
const notifyChannelId = process.env.DISCORD_NOTIFY_CHANNEL_ID ?? null;

// Redis
const sharedRedis = new Redis(redisUrl);
sharedRedis.on("error", (err: Error) => {
  console.warn("[redis] connection error:", err.message);
});

// cc-wire factory
const wire = createCcWire(sharedRedis);

// Singleton instance ID — used to detect stale processes after a restart
const instanceId = randomUUID();
const INSTANCE_KEY = "cca:discord:instance";
const INSTANCE_TTL_MS = 30_000;
const INSTANCE_REFRESH_MS = 10_000;

sharedRedis.once("ready", () => {
  // Announce version
  sharedRedis.set(`cca:meta:cc-discord:version`, version).catch((err: Error) => {
    console.warn("[redis] failed to write version:", err.message);
  });
  console.log(`[cc-discord] version:reported ${version}`);

  // Write singleton instance ID with 30s TTL
  sharedRedis.set(INSTANCE_KEY, instanceId, "PX", INSTANCE_TTL_MS).catch((err: Error) => {
    console.warn("[cc-discord] failed to write instance ID:", err.message);
  });
  console.log(`[cc-discord] instance:${instanceId}`);

  // Refresh TTL every 10s so launchd-respawned processes displace old ones
  setInterval(() => {
    sharedRedis.set(INSTANCE_KEY, instanceId, "PX", INSTANCE_TTL_MS).catch((err: Error) => {
      console.warn("[cc-discord] instance refresh failed:", err.message);
    });
  }, INSTANCE_REFRESH_MS);

  // Store master token so MetaAgentManager can retrieve it
  wire.token.setMaster(claudeToken!).catch((err: Error) => {
    console.warn("[cc-discord] failed to set master token:", err.message);
  });

  // Run startup migrations (async, best-effort)
  void runStartupMigrations();
});

/**
 * Migrate old Redis data formats to the v0.2.0 layout.
 * Runs once per startup.
 */
async function runStartupMigrations(): Promise<void> {
  // 1. Migrate old STRING channel keys to new HSET format
  let stringKeys: string[];
  try {
    stringKeys = await sharedRedis.keys("cca:discord:channel:*");
  } catch (err) {
    console.warn("[cc-discord] channel key scan failed:", (err as Error).message);
    stringKeys = [];
  }

  for (const key of stringKeys) {
    try {
      const type = await sharedRedis.type(key);
      if (type !== "string") continue; // already migrated or different type
      const raw = await sharedRedis.get(key);
      if (!raw) continue;
      const { namespace: ns, repoUrl } = JSON.parse(raw) as { namespace: string; repoUrl: string };
      const channelId = key.slice("cca:discord:channel:".length);
      await wire.discord.registerChannel(channelId, ns, repoUrl);
      await sharedRedis.del(key);
      console.log(`[cc-discord] migrated channel key ${channelId} → HSET`);
    } catch (err) {
      console.warn(`[cc-discord] channel key migration failed for ${key}:`, (err as Error).message);
    }
  }

  // 2. Migrate old meta input keys (cca:meta:{ns}:input → cca:discord:meta:{ns}:input)
  await migrateMetaInputKeys(sharedRedis);

  console.log("[cc-discord] startup migrations complete");

  // 3. Start meta-agent polling now that data is migrated
  bot.startMetaAgentPolling();
}

// Mutable placeholder closures — filled in once `bot` is created below
let getLastActiveChannelIdFn: () => string | undefined = () => undefined;
let handleUserMessageFn: ((channelId: string, text: string) => void) | undefined;
let forwardNotificationFn: ((channelId: string, text: string) => void) | undefined;

const bot = new CcDiscordBot({
  discordToken,
  claudeToken,
  cwd,
  allowedUserIds,
  guildIds,
  redis: sharedRedis,
  namespace,
  instanceId,
  registerRoutedChannelId: (ns, channelId) => notifier.registerRoutedChannelId(ns, channelId),
});

const notifier = startNotifier(
  bot,
  notifyChannelId,
  namespace,
  sharedRedis,
  (channelId, text) => handleUserMessageFn?.(channelId, text),
  (channelId, text) => forwardNotificationFn?.(channelId, text),
  () => getLastActiveChannelIdFn(),
  (n) => bot.reverseSnowflakeLookup(n),
  (ns) => bot.getChannelIdForNamespace(ns),
);
console.log(`[notifier] started for namespace=${namespace} notifyChannelId=${notifyChannelId ?? "dynamic"}`);

// Restore persisted channel→namespace mappings so routing survives restarts
bot.loadChannelMappings().catch((err: Error) => {
  console.warn("[cc-discord] loadChannelMappings failed:", err.message);
});

// Wire closures now that bot is constructed
getLastActiveChannelIdFn = () => bot.getLastActiveChannelId();
handleUserMessageFn = (channelId, text) => { void bot.handleUserMessage(channelId, text); };
forwardNotificationFn = (channelId, text) => { bot.forwardNotification(channelId, text); };

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  bot.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  bot.stop();
  process.exit(0);
});
