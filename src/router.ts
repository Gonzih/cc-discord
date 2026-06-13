/**
 * Routing helpers: channel-creation intent detection and meta-agent routing.
 *
 * v0.2.0: cc-discord owns meta-agent lifecycle directly.
 * routeToMetaAgent now writes to the discord-scoped input key (cca:discord:meta:{ns}:input).
 * ensureMetaAgent has been removed — use MetaAgentManager.ensureWorkspace instead.
 */

import { Redis } from "ioredis";
import { discordMetaInputKey } from "@gonzih/cc-wire";

/**
 * Detect a natural-language channel-creation request.
 * Matches:
 *   "channel for https://github.com/org/repo"
 *   "create channel for https://github.com/org/repo"
 *   "add channel for https://github.com/org/repo"
 *
 * Returns { namespace, repoUrl } or null.
 */
export function parseChannelCreateIntent(text: string): { namespace: string; repoUrl: string } | null {
  const match = text.match(/(?:create\s+|add\s+)?channel\s+for\s+(https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+))/i);
  if (!match) return null;
  const repoUrl = match[1];
  const namespace = match[3];
  return { namespace, repoUrl };
}

/**
 * Route a message to a running meta-agent via Redis RPUSH.
 * cc-discord polls cca:discord:meta:{namespace}:input every 3s.
 *
 * No-op when strippedMessage is empty.
 */
export async function routeToMetaAgent(
  namespace: string,
  strippedMessage: string,
  redis: Redis
): Promise<void> {
  if (!strippedMessage) return;

  const entry = JSON.stringify({
    id: crypto.randomUUID(),
    content: strippedMessage,
    timestamp: new Date().toISOString(),
  });
  await redis.rpush(discordMetaInputKey(namespace), entry);
  console.log(`[router] routed message to meta-agent namespace=${namespace}`);
}
