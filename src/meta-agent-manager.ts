/**
 * MetaAgentManager — cc-discord owns Claude session lifecycle for routed namespaces.
 *
 * Flow per namespace:
 *   1. ensureWorkspace: git clone repo to ~/cc-discord-workspace/{ns}
 *   2. injectMcp: write .mcp.json so the claude subprocess has MCP tool access
 *   3. pollQueues (3s interval): wire.discord.dequeue(ns) → spawnSession(ns, content)
 *   4. spawnSession: claude --continue -p "{message}" pipes stdout → wire.discord.publishOutgoing
 */

import { spawn, execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  CC_DISCORD_WORKSPACE_ROOT,
  TIMING,
  discordMetaInputKey,
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
  const trustedOwners = process.env.CC_AGENT_TRUSTED_OWNERS ?? "";
  const systemPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";

  const config = {
    mcpServers: {
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
 */
function resolveClaude(): string {
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
 * Spawn `claude --continue -p "{message}" --dangerously-skip-permissions` in the
 * namespace workspace. Pipes stdout line-by-line → wire.discord.publishOutgoing.
 * Returns a Promise that resolves when the process exits.
 */
export function spawnSession(ns: string, message: string, token: string, wire: Wire): Promise<void> {
  return new Promise((resolve, reject) => {
    const wsPath = workspacePath(ns);
    const claudeBin = resolveClaude();

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (token.startsWith("sk-ant-api")) {
      env.ANTHROPIC_API_KEY = token;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      env.CLAUDE_CODE_OAUTH_TOKEN = token;
      delete env.ANTHROPIC_API_KEY;
    }

    const proc = spawn(
      claudeBin,
      [
        "--continue",
        "-p", message,
        "--output-format", "text",
        "--dangerously-skip-permissions",
      ],
      { cwd: wsPath, env, stdio: ["ignore", "pipe", "pipe"] }
    );

    let lineBuffer = "";

    const publishLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const msg = {
        id: crypto.randomUUID(),
        source: "claude" as const,
        role: "assistant" as const,
        content: trimmed,
        timestamp: new Date().toISOString(),
        chatId: 0,
      };
      wire.discord.publishOutgoing(ns, msg).catch((err: Error) => {
        console.warn(`[meta-agent-manager] publishOutgoing failed (ns=${ns}):`, err.message);
      });
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        publishLine(line);
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.log(`[meta-agent-manager:${ns}:stderr] ${text}`);
    });

    proc.on("exit", (code) => {
      // Flush any remaining buffered content
      if (lineBuffer.trim()) publishLine(lineBuffer);
      lineBuffer = "";
      console.log(`[meta-agent-manager] session exited (ns=${ns}, code=${code})`);
      resolve();
    });

    proc.on("error", (err: Error) => {
      console.error(`[meta-agent-manager] spawn error (ns=${ns}):`, err.message);
      reject(err);
    });
  });
}

export interface MetaAgentManager {
  ensureWorkspace: (ns: string, repoUrl: string) => Promise<void>;
  injectMcp: (ns: string, token: string) => void;
  startPolling: (wire: Wire, getNamespaces: () => string[]) => void;
  stop: () => void;
}

/**
 * Create a MetaAgentManager that polls input queues and spawns sessions.
 */
export function createMetaAgentManager(): MetaAgentManager {
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  const activeNamespaces = new Set<string>();

  return {
    async ensureWorkspace(ns, repoUrl) {
      await ensureWorkspace(ns, repoUrl);
    },

    injectMcp(ns, token) {
      const wsPath = workspacePath(ns);
      injectMcp(ns, wsPath, token);
    },

    startPolling(wire, getNamespaces) {
      if (pollInterval) return; // already running

      pollInterval = setInterval(() => {
        const namespaces = getNamespaces();
        if (namespaces.length === 0) return;

        for (const ns of namespaces) {
          if (activeNamespaces.has(ns)) continue;

          wire.discord.dequeue(ns)
            .then(async (msg) => {
              if (!msg) return;
              const content = typeof msg === "string" ? msg : (msg as { content?: string }).content ?? String(msg);

              activeNamespaces.add(ns);
              await wire.discord.setStatus(ns, {
                namespace: ns,
                status: "running",
                isTyping: true,
                turnCount: 0,
                updatedAt: new Date().toISOString(),
              });

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
                activeNamespaces.delete(ns);
                await wire.discord.setStatus(ns, {
                  namespace: ns,
                  status: "idle",
                  isTyping: false,
                  turnCount: 0,
                  updatedAt: new Date().toISOString(),
                });
                return;
              }

              spawnSession(ns, content, token, wire)
                .catch((err: Error) => {
                  console.error(`[meta-agent-manager] session error (ns=${ns}):`, err.message);
                })
                .finally(() => {
                  activeNamespaces.delete(ns);
                  wire.discord.setStatus(ns, {
                    namespace: ns,
                    status: "idle",
                    isTyping: false,
                    turnCount: 0,
                    updatedAt: new Date().toISOString(),
                  }).catch(() => {});
                });
            })
            .catch((err: Error) => {
              console.warn(`[meta-agent-manager] dequeue error (ns=${ns}):`, err.message);
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
