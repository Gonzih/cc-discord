/**
 * Routing helpers: channel-creation intent detection and meta-agent routing.
 */

import { execSync } from "child_process";
import { Redis } from "ioredis";
import { metaAgentStatusKey, metaKey, metaInputKey } from "@gonzih/cc-wire";

/** Callback type matching CcDiscordBot.callCcAgentTool */
export type CallToolFn = (toolName: string, args?: Record<string, unknown>) => Promise<string | null>;

/**
 * Ensure a meta-agent for the given namespace is running.
 *
 * Steps:
 *   1. Check Redis for readiness via two keys (see below) — return early if already ready.
 *   2. Verify the GitHub repo exists; create it (public) if not.
 *   3. Call the start_meta_agent MCP tool via callTool.
 *   4. Poll both Redis keys every 1s until ready or META_AGENT_TIMEOUT_MS expires.
 *
 * Two Redis keys are checked:
 *   cca:meta-agent:status:{namespace} — live-status key written by writeLiveStatus()
 *     (only populated after the first message is processed by messageMetaAgent)
 *   cca:meta:{namespace} — state key written by startMetaAgent() directly via saveState()
 *     (populated as soon as the workspace is created, with status:"idle")
 *
 * Bug context: start_meta_agent writes cca:meta:{namespace} but NOT cca:meta-agent:status:{namespace}.
 * Polling only the status key caused a 10s timeout on every cold start.
 *
 * Throws on failure (repo creation error, tool call failure, or timeout).
 */
export async function ensureMetaAgent(
  namespace: string,
  repoUrl: string,
  callTool: CallToolFn,
  redis: Redis
): Promise<void> {
  const timeoutMs = parseInt(process.env.META_AGENT_TIMEOUT_MS ?? "10000", 10);
  const statusKey = metaAgentStatusKey(namespace);
  // State key written by startMetaAgent() directly — the source of truth for workspace existence.
  const stateKey = metaKey(namespace);

  console.log(`[router] ensureMetaAgent namespace=${namespace}`);

  // Fast path: check live-status key (written by messageMetaAgent after first message)
  const statusRaw = await redis.get(statusKey);
  if (statusRaw) {
    try {
      const status = JSON.parse(statusRaw) as { status?: string };
      if (status.status === "running" || status.status === "idle") {
        console.log(`[router] meta-agent ${namespace} is already ready (status=${status.status})`);
        return;
      }
    } catch {
      // Corrupt status value — fall through
    }
  }

  // Fast path: also check state key (written by startMetaAgent, persists 30 days).
  // Presence of this key means the workspace was already created — no need to re-run start_meta_agent.
  const stateRaw = await redis.get(stateKey);
  if (stateRaw) {
    try {
      const state = JSON.parse(stateRaw) as { status?: string };
      if (state.status === "idle" || state.status === "running") {
        console.log(`[router] meta-agent ${namespace} workspace exists (state.status=${state.status})`);
        return;
      }
    } catch {
      // Corrupt state — fall through and re-initialize
    }
  }

  // Derive "org/repo" from the full URL for gh CLI calls
  const orgRepo = repoUrl.replace(/^https:\/\/github\.com\//, "");

  // Verify / create the GitHub repo
  try {
    execSync(`gh repo view ${orgRepo}`, { stdio: "ignore" });
  } catch {
    // Repo not found — create it
    try {
      execSync(
        `gh repo create ${orgRepo} --public --description "Meta-agent workspace for ${namespace}"`,
        { stdio: "pipe" }
      );
      console.log(`[router] created repo ${orgRepo} for namespace=${namespace}`);
    } catch (createErr) {
      throw new Error(`Failed to create repo ${orgRepo}: ${(createErr as Error).message}`);
    }
  }

  // Start the meta-agent via MCP (clones workspace if needed, writes cca:meta:{namespace})
  const result = await callTool("start_meta_agent", { namespace, repo_url: repoUrl });
  if (result === null) {
    throw new Error(`start_meta_agent returned null — tool may not be available in cc-agent`);
  }

  // Check for explicit failure payload (e.g. git clone error)
  try {
    const parsed = JSON.parse(result) as { ok?: boolean; error?: string };
    if (parsed.ok === false) {
      throw new Error(`start_meta_agent failed: ${parsed.error ?? "unknown error"}`);
    }
  } catch (jsonErr) {
    if (!(jsonErr instanceof SyntaxError)) throw jsonErr;
    // Non-JSON result (e.g. plain "ok") — not an error, continue to poll
  }

  // Poll until ready. Check both keys:
  //   - statusKey: written by writeLiveStatus() during messageMetaAgent (may not exist yet on cold start)
  //   - stateKey:  written by startMetaAgent() above — will appear within 1s of the tool call returning
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));

    const raw = await redis.get(statusKey);
    if (raw) {
      try {
        const s = JSON.parse(raw) as { status?: string };
        console.log(`[router] waiting for meta-agent ${namespace} — status key: ${s.status}`);
        if (s.status === "running" || s.status === "idle") return;
      } catch {
        // ignore parse errors, keep polling
      }
    }

    // Also check state key — startMetaAgent writes this synchronously before responding
    const state = await redis.get(stateKey);
    if (state) {
      try {
        const s = JSON.parse(state) as { status?: string };
        console.log(`[router] waiting for meta-agent ${namespace} — state key: ${s.status}`);
        if (s.status === "idle" || s.status === "running") return;
      } catch {
        // ignore parse errors, keep polling
      }
    } else {
      console.log(`[router] waiting for meta-agent ${namespace} — neither key present yet`);
    }
  }

  throw new Error(`Meta-agent for ${namespace} did not become ready within ${timeoutMs}ms`);
}

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
 * The cc-agent polls cca:meta:{namespace}:input every 3s (up to 3s delivery latency).
 *
 * No-op when strippedMessage is empty (user sent only the tag token).
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
  // FIFO — cc-agent reads via LPOP
  await redis.rpush(metaInputKey(namespace), entry);
  console.log(`[router] routed message to meta-agent namespace=${namespace}`);
}
