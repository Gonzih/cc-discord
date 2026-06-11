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
 *   CC_AGENT_NAMESPACE         — cc-agent namespace (default: money-brain)
 *   REDIS_URL                  — Redis connection URL (default: redis://localhost:6379)
 *   CWD                        — working directory for Claude Code (default: process.cwd())
 *   DEFAULT_GITHUB_ORG         — default GitHub org for #repo routing (default: gonzih)
 */

import { Redis } from "ioredis";
import { CcDiscordBot } from "./bot.js";
import { startNotifier } from "./notifier.js";
import { loadTokens } from "./tokens.js";

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
sharedRedis.once("ready", () => {
  // Announce this version on Redis so other services can discover cc-discord
  sharedRedis.set(`cca:meta:cc-discord:version`, "0.1.0").catch((err: Error) => {
    console.warn("[redis] failed to write version:", err.message);
  });
  console.log("[cc-discord] version:reported 0.1.0");
});

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
);
console.log(`[notifier] started for namespace=${namespace} notifyChannelId=${notifyChannelId ?? "dynamic"}`);

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
