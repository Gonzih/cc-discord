/**
 * MetaAgentManager — cc-discord owns Claude session lifecycle for routed namespaces.
 *
 * Flow per namespace:
 *   1. ensureWorkspace: git clone repo to ~/cc-discord-workspace/{ns}
 *   2. injectMcp: write .mcp.json so the claude subprocess has MCP tool access
 *   3. ensureSession: spawn one persistent `claude --continue` process per namespace
 *      (no -p flag — messages go via stdin)
 *   4. On new message: write "${message}\n" to stdin of the running process
 *   5. On process exit: remove from sessions map; next message respawns
 *
 * The polling loop now just drains any queued Redis messages into stdin.
 * No more per-message process spawn — Claude receives messages in sequence.
 */

import { spawn, execSync, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  CC_DISCORD_WORKSPACE_ROOT,
  TIMING,
  DISCORD_INSTANCE_KEY,
  discordMetaInputKey,
  metaStreamChannel as ccWireMetaStreamChannel,
  metaLogKey as ccWireMetaLogKey,
} from "@gonzih/cc-wire";
import type { createCcWire } from "@gonzih/cc-wire";

type Wire = ReturnType<typeof createCcWire>;

const WORKSPACE_ROOT = join(homedir(), CC_DISCORD_WORKSPACE_ROOT);

/**
 * Returns the path to the workspace for the given namespace.
 * Creates the parent root directory if needed.
 */
export function workspacePath(ns: string): string {
  return join(WORKSPACE_ROOT, ns);
}

/**
 * Clone the repo to ~/cc-discord-workspace/{ns} if not already present.
 * No-op if the directory already exists.
 */
export async function ensureWorkspace(ns: string, repoUrl: string): Promise<void> {
  const wsPath = workspacePath(ns);
  if (existsSync(wsPath)) {
    console.log(`[meta-agent-manager] workspace exists: ${wsPath}`);
    return;
  }
  mkdirSync(WORKSPACE_ROOT, { recursive: true });
  console.log(`[meta-agent-manager] cloning ${repoUrl} → ${wsPath}`);
  execSync(`git clone ${repoUrl} ${wsPath}`, { stdio: "pipe" });
  console.log(`[meta-agent-manager] clone complete for namespace=${ns}`);
  try {
    execSync(`/opt/homebrew/bin/git-kb init`, { cwd: wsPath, stdio: "pipe" });
    console.log(`[meta-agent-manager] gitkb initialized for namespace=${ns}`);
  } catch (err) {
    console.warn(`[meta-agent-manager] gitkb init failed (ns=${ns}):`, (err as Error).message);
  }
}

/**
 * Write .mcp.json to the workspace so the claude session has MCP tool access.
 *
 * Template priority:
 *   1. CC_DISCORD_MCP_JSON env var (full JSON string) — operator-supplied override
 *   2. Built-in template: cc-agent MCP server with namespace-scoped env
 *
 * Variables substituted in the template: {namespace}, {workspacePath}, {token},
 * {npmCache}, {trustedOwners}, {path}.
 */
export function injectMcp(ns: string, wsPath: string, token: string): void {
  const mcpPath = join(wsPath, ".mcp.json");

  if (process.env.CC_DISCORD_MCP_JSON) {
    const rendered = process.env.CC_DISCORD_MCP_JSON
      .replace(/\{namespace\}/g, ns)
      .replace(/\{workspacePath\}/g, wsPath)
      .replace(/\{token\}/g, token);
    writeFileSync(mcpPath, rendered, "utf8");
    console.log(`[meta-agent-manager] injected MCP config (from CC_DISCORD_MCP_JSON) for ${ns}`);
    return;
  }

  const npmCache = process.env.npm_config_cache ?? `${homedir()}/.npm`;
  const trustedOwners = process.env.CC_AGENT_TRUSTED_OWNERS ?? "gonzih,ecoclaw,simorgh-app";
  const systemPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";

  const config = {
    mcpServers: {
      "gitkb": {
        command: "/opt/homebrew/bin/git-kb",
        args: ["mcp"],
      },
      "cc-agent": {
        command: "/opt/homebrew/bin/npx",
        args: ["-y", "--prefer-online", "@gonzih/cc-agent"],
        env: {
          CC_AGENT_NAMESPACE: ns,
          CWD: wsPath,
          CLAUDE_CODE_OAUTH_TOKEN: token,
          CLAUDE_TOKENS: token,
          CC_AGENT_TRUSTED_OWNERS: trustedOwners,
          PATH: systemPath,
          npm_config_cache: npmCache,
        },
      },
    },
  };

  writeFileSync(mcpPath, JSON.stringify(config, null, 2), "utf8");
  console.log(`[meta-agent-manager] injected MCP config for namespace=${ns}`);
}

/**
 * Resolve claude binary — same logic as claude.ts resolveClaude.
 * Checks CLAUDE_BIN env var first, then PATH + common fallback locations.
 */
function resolveClaude(): string {
  // Allow test/operator override via CLAUDE_BIN
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;

  const dirs = (process.env.PATH ?? "").split(":");
  for (const dir of dirs) {
    const c = `${dir}/claude`;
    if (existsSync(c)) return c;
  }
  const fallbacks = [
    `${homedir()}/.npm-global/bin/claude`,
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
  for (const p of fallbacks) {
    if (existsSync(p)) return p;
  }
  return "claude";
}

/**
 * Redis keys for meta-agent stdout streaming.
 * cca:meta:{ns}:stream — pub/sub channel (live streaming)
 * cca:meta:{ns}:log    — list (history, capped at 2000)
 * Re-exported from cc-wire for backwards-compat with callers in this package.
 */
export const metaStreamChannel = ccWireMetaStreamChannel;
export const metaLogKey = ccWireMetaLogKey;

/**
 * Build the env object for a claude subprocess based on the token type.
 */
function buildEnv(token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (token.startsWith("sk-ant-api")) {
    env.ANTHROPIC_API_KEY = token;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    env.CLAUDE_CODE_OAUTH_TOKEN = token;
    delete env.ANTHROPIC_API_KEY;
  }
  return env;
}

/**
 * Wire stdout from a claude subprocess into Redis.
 * Parses JSONL lines from stream-json format, publishes to:
 *   PUBLISH cca:meta:{ns}:stream
 *   LPUSH   cca:meta:{ns}:log  (capped at 2000)
 * Also dispatches assistant/result text to wire.discord.publishOutgoing.
 */
function wireStdoutToRedis(
  proc: ChildProcess,
  ns: string,
  wire: Wire,
): void {
  const rawRedis = wire._redis;
  const streamCh = metaStreamChannel(ns);
  const logKey = metaLogKey(ns);

  const forwardEventToRedis = (eventJson: string): void => {
    rawRedis.publish(streamCh, eventJson).catch((err: Error) => {
      console.warn(`[meta-agent-manager] stream publish failed (ns=${ns}):`, err.message);
    });
    rawRedis.lpush(logKey, eventJson).then(() => {
      rawRedis.ltrim(logKey, 0, 1999).catch(() => {});
    }).catch((err: Error) => {
      console.warn(`[meta-agent-manager] log lpush failed (ns=${ns}):`, err.message);
    });
  };

  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let structuredEvent: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const type = parsed.type as string | undefined;
      if (type === "assistant") {
        const content = parsed.message as { content?: Array<{ type: string; text?: string }> } | undefined;
        const textBlock = content?.content?.find((b) => b.type === "text");
        const text = textBlock?.text ?? "";
        structuredEvent = { type: "assistant", text };
        if (text) {
          const msg = {
            id: crypto.randomUUID(),
            source: "claude" as const,
            role: "assistant" as const,
            content: text,
            timestamp: new Date().toISOString(),
            chatId: 0,
          };
          wire.discord.publishOutgoing(ns, msg).catch((err: Error) => {
            console.warn(`[meta-agent-manager] publishOutgoing failed (ns=${ns}):`, err.message);
          });
        }
      } else if (type === "tool_use") {
        structuredEvent = {
          type: "tool_use",
          name: parsed.name ?? "",
          input: parsed.input ?? {},
        };
      } else if (type === "tool_result") {
        structuredEvent = {
          type: "tool_result",
          content: parsed.content ?? "",
        };
      } else if (type === "result") {
        const resultText = typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result ?? "");
        structuredEvent = {
          type: "result",
          result: resultText,
          is_error: parsed.is_error ?? false,
        };
        if (resultText) {
          const msg = {
            id: crypto.randomUUID(),
            source: "claude" as const,
            role: "assistant" as const,
            content: resultText,
            timestamp: new Date().toISOString(),
            chatId: 0,
          };
          wire.discord.publishOutgoing(ns, msg).catch((err: Error) => {
            console.warn(`[meta-agent-manager] publishOutgoing (result) failed (ns=${ns}):`, err.message);
          });
        }
      } else {
        structuredEvent = parsed;
      }
    } catch {
      structuredEvent = { type: "text", text: trimmed };
    }

    forwardEventToRedis(JSON.stringify(structuredEvent));
  };

  let lineBuffer = "";

  proc.stdout!.on("data", (chunk: Buffer) => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      processLine(line);
    }
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) console.log(`[meta-agent-manager:${ns}:stderr] ${text}`);
  });

  proc.on("exit", () => {
    // Flush remaining buffered content
    if (lineBuffer.trim()) processLine(lineBuffer);
    lineBuffer = "";
  });
}

/**
 * Spawn `claude --continue -p "{message}" --dangerously-skip-permissions` in the
 * namespace workspace. Pipes stdout line-by-line → wire.discord.publishOutgoing.
 * Also streams each chunk to Redis: PUBLISH cca:meta:{ns}:stream and LPUSH cca:meta:{ns}:log.
 * Returns a Promise that resolves when the process exits.
 *
 * Kept for backwards-compat and direct integration-test usage.
 */
export function spawnSession(ns: string, message: string, token: string, wire: Wire): Promise<void> {
  return new Promise((resolve, reject) => {
    const wsPath = workspacePath(ns);
    const claudeBin = resolveClaude();
    const env = buildEnv(token);

    const proc = spawn(
      claudeBin,
      [
        "--continue",
        "-p", message,
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ],
      { cwd: wsPath, env, stdio: ["ignore", "pipe", "pipe"] }
    );

    wireStdoutToRedis(proc, ns, wire);

    proc.on("exit", (code) => {
      console.log(`[meta-agent-manager] session exited (ns=${ns}, code=${code})`);
      resolve();
    });

    proc.on("error", (err: Error) => {
      console.error(`[meta-agent-manager] spawn error (ns=${ns}):`, err.message);
      reject(err);
    });
  });
}

/**
 * Internal state for a persistent Claude session.
 */
interface PersistentSession {
  proc: ChildProcess;
  ns: string;
}

export interface MetaAgentManager {
  ensureWorkspace: (ns: string, repoUrl: string) => Promise<void>;
  injectMcp: (ns: string, token: string) => void;
  startPolling: (
    wire: Wire,
    getNamespaces: () => Array<{ namespace: string; repoUrl: string }>,
    instanceId?: string
  ) => void;
  stop: () => void;
  /** Kill and remove the persistent session for a namespace (e.g. on /clear). */
  killSession: (ns: string) => void;
  /** Write a raw line to the stdin of the running session, if any. */
  sendToSession: (ns: string, line: string) => void;
}

/**
 * Spawn a persistent `claude --continue` process for a namespace.
 * No -p flag — messages are delivered via stdin.
 * Stdout is wired to Redis via wireStdoutToRedis.
 * Returns the ChildProcess.
 */
function spawnPersistentSession(
  ns: string,
  token: string,
  wire: Wire,
  onExit: () => void,
): ChildProcess {
  const wsPath = workspacePath(ns);
  const claudeBin = resolveClaude();
  const env = buildEnv(token);

  console.log(`[meta-agent-manager] spawning persistent session (ns=${ns})`);

  const proc = spawn(
    claudeBin,
    [
      "--continue",
      "-p",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ],
    { cwd: wsPath, env, stdio: ["pipe", "pipe", "pipe"] }
  );

  proc.stdin!.setDefaultEncoding("utf8");

  wireStdoutToRedis(proc, ns, wire);

  proc.on("exit", (code) => {
    console.log(`[meta-agent-manager] persistent session exited (ns=${ns}, code=${code})`);
    onExit();
  });

  proc.on("error", (err: Error) => {
    console.error(`[meta-agent-manager] persistent session spawn error (ns=${ns}):`, err.message);
    onExit();
  });

  return proc;
}

/**
 * Create a MetaAgentManager that maintains one persistent Claude process per namespace.
 *
 * On first message for a namespace:
 *   1. ensureWorkspace + injectMcp
 *   2. Drain any pending Redis queue entries to stdin
 *   3. Write the new message to stdin
 *
 * On subsequent messages: write directly to stdin of the running process.
 *
 * On process exit: remove from sessions map. Next message triggers a respawn.
 *
 * The 3-second poll loop drains any messages that arrived while a session was
 * starting up or temporarily unavailable.
 */
export function createMetaAgentManager(): MetaAgentManager {
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  /** One persistent ChildProcess per namespace. */
  const sessions = new Map<string, PersistentSession>();
  /** Namespaces currently being set up (workspace clone / first spawn). */
  const startingUp = new Set<string>();

  /**
   * Write a line to the stdin of the persistent session for ns.
   * Silently no-ops if no session exists.
   */
  function writeToStdin(ns: string, line: string): void {
    const session = sessions.get(ns);
    if (!session) return;
    try {
      // --input-format stream-json expects JSON lines: {"role":"user","content":"..."}
      const payload = JSON.stringify({ role: "user", content: line });
      session.proc.stdin!.write(`${payload}\n`);
    } catch (err) {
      console.warn(`[meta-agent-manager] stdin write failed (ns=${ns}):`, (err as Error).message);
    }
  }

  /**
   * Drain all pending messages from the Redis input queue into the session's stdin.
   */
  async function drainQueue(ns: string, wire: Wire): Promise<void> {
    const inputKey = discordMetaInputKey(ns);
    for (;;) {
      let raw: string | null;
      try {
        raw = await wire._redis.lpop(inputKey);
      } catch {
        break;
      }
      if (!raw) break;

      let content: string;
      try {
        content = (JSON.parse(raw) as { content?: string }).content ?? raw;
      } catch {
        content = raw;
      }

      writeToStdin(ns, content);
    }
  }

  /**
   * Ensure a persistent session exists for ns.
   * If one already exists, returns immediately.
   * If not, spawns one, drains any queued messages, then writes `firstMessage` if provided.
   */
  async function ensureSession(
    ns: string,
    repoUrl: string,
    token: string,
    wire: Wire,
    firstMessage?: string,
  ): Promise<void> {
    if (sessions.has(ns)) {
      if (firstMessage !== undefined) writeToStdin(ns, firstMessage);
      return;
    }

    if (startingUp.has(ns)) {
      // Already spinning up — queue the message so drainQueue picks it up
      return;
    }

    startingUp.add(ns);
    try {
      // Ensure workspace exists
      const wsPath = workspacePath(ns);
      await ensureWorkspace(ns, repoUrl);
      injectMcp(ns, wsPath, token);

      const proc = spawnPersistentSession(ns, token, wire, () => {
        // On exit: remove from map so next message triggers a respawn
        sessions.delete(ns);
        console.log(`[meta-agent-manager] session removed from map (ns=${ns})`);
      });

      sessions.set(ns, { proc, ns });

      // Drain any messages that arrived before this session started
      await drainQueue(ns, wire);

      // Write the triggering message last (after queue drain, in order)
      if (firstMessage !== undefined) writeToStdin(ns, firstMessage);

      await wire.discord.setStatus(ns, {
        namespace: ns,
        status: "running",
        isTyping: true,
        turnCount: 0,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[meta-agent-manager] ensureSession failed (ns=${ns}):`, (err as Error).message);
      sessions.delete(ns);
    } finally {
      startingUp.delete(ns);
    }
  }

  return {
    async ensureWorkspace(ns, repoUrl) {
      await ensureWorkspace(ns, repoUrl);
    },

    injectMcp(ns, token) {
      const wsPath = workspacePath(ns);
      injectMcp(ns, wsPath, token);
    },

    startPolling(wire, getNamespaces, instanceId) {
      if (pollInterval) return; // already running

      pollInterval = setInterval(() => {
        const namespaces = getNamespaces();
        if (namespaces.length === 0) return;

        for (const { namespace: ns, repoUrl } of namespaces) {
          // Stale-instance check
          if (instanceId) {
            wire._redis.get(DISCORD_INSTANCE_KEY).then((current) => {
              if (current && current !== instanceId) {
                console.log(`[meta-agent-manager] stale instance detected (current=${current}, ours=${instanceId}) — exiting`);
                process.exit(0);
              }
            }).catch(() => {});
          }

          // If session exists, drain any queued messages
          if (sessions.has(ns)) {
            drainQueue(ns, wire).catch((err: Error) => {
              console.warn(`[meta-agent-manager] drainQueue error (ns=${ns}):`, err.message);
            });
            continue;
          }

          // Check if anything is queued for this namespace
          const inputKey = discordMetaInputKey(ns);
          wire._redis.llen(inputKey).then(async (queueLen) => {
            if (queueLen === 0) return;

            // Resolve token
            let token: string;
            try {
              token = await wire.token.getMaster();
            } catch {
              token = process.env.CLAUDE_CODE_OAUTH_TOKEN
                ?? process.env.CLAUDE_CODE_TOKEN
                ?? process.env.ANTHROPIC_API_KEY
                ?? "";
            }

            if (!token) {
              console.warn(`[meta-agent-manager] no token available, skipping session for ns=${ns}`);
              return;
            }

            // ensureSession will drain the queue itself
            await ensureSession(ns, repoUrl, token, wire);
          }).catch((err: Error) => {
            console.warn(`[meta-agent-manager] llen error (ns=${ns}):`, err.message);
          });
        }
      }, TIMING.INPUT_POLL_INTERVAL_MS);

      console.log(`[meta-agent-manager] polling started (interval=${TIMING.INPUT_POLL_INTERVAL_MS}ms)`);
    },

    stop() {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
        console.log("[meta-agent-manager] polling stopped");
      }
      // Kill all active sessions
      for (const [ns, session] of sessions) {
        try {
          session.proc.stdin!.end();
          session.proc.kill();
        } catch {
          // ignore errors during shutdown
        }
        sessions.delete(ns);
        console.log(`[meta-agent-manager] killed session on stop (ns=${ns})`);
      }
    },

    killSession(ns) {
      const session = sessions.get(ns);
      if (!session) return;
      try {
        session.proc.stdin!.end();
        session.proc.kill();
      } catch {
        // ignore
      }
      sessions.delete(ns);
      console.log(`[meta-agent-manager] killed session (ns=${ns})`);
    },

    sendToSession(ns, line) {
      writeToStdin(ns, line);
    },
  };
}

/**
 * Migrate the old cc-agent meta input key to the new cc-discord key.
 * Old: cca:meta:{ns}:input → New: cca:discord:meta:{ns}:input
 *
 * Called once on startup.
 */
export async function migrateMetaInputKeys(redis: { keys: (p: string) => Promise<string[]>; lrange: (k: string, s: number, e: number) => Promise<string[]>; rpush: (k: string, ...v: string[]) => Promise<number>; del: (k: string) => Promise<number> }): Promise<void> {
  let oldKeys: string[];
  try {
    oldKeys = await redis.keys("cca:meta:*:input");
  } catch (err) {
    console.warn("[meta-agent-manager] migrateMetaInputKeys keys scan failed:", (err as Error).message);
    return;
  }

  for (const key of oldKeys) {
    const match = key.match(/^cca:meta:(.+):input$/);
    if (!match) continue;
    const ns = match[1];
    const newKey = discordMetaInputKey(ns);
    try {
      const items = await redis.lrange(key, 0, -1);
      if (items.length > 0) {
        // lrange returns newest-first; reverse to maintain enqueue order
        await redis.rpush(newKey, ...items.reverse());
        console.log(`[meta-agent-manager] migrated ${items.length} items: ${key} → ${newKey}`);
      }
      await redis.del(key);
    } catch (err) {
      console.warn(`[meta-agent-manager] migration failed for ${key}:`, (err as Error).message);
    }
  }
}
