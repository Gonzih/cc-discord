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
  discordChatOutgoing,
  metaStreamChannel as ccWireMetaStreamChannel,
  metaLogKey as ccWireMetaLogKey,
} from "@gonzih/cc-wire";
import type { createCcWire } from "@gonzih/cc-wire";

type Wire = ReturnType<typeof createCcWire>;
type JsonRecord = Record<string, unknown>;

const WORKSPACE_ROOT = join(homedir(), CC_DISCORD_WORKSPACE_ROOT);
type AgentDriver = "claude" | "codex";
const CHAT_SOURCE = "claude" as const;

function agentDriver(): AgentDriver {
  const raw = (process.env.CC_DISCORD_AGENT_DRIVER ?? process.env.AGENT_DRIVER ?? "claude").toLowerCase();
  return raw === "codex" ? "codex" : "claude";
}

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
 *   2. Built-in template: gitkb MCP plus ATC shell environment
 *
 * Variables substituted in the template: {namespace}, {workspacePath}, {token},
 * {npmCache}, {trustedOwners}, {path}.
 */
export function injectMcp(ns: string, wsPath: string, token: string): void {
  const mcpPath = join(wsPath, ".mcp.json");
  const codexDir = join(wsPath, ".codex");
  const codexConfigPath = join(codexDir, "config.toml");
  const agentsPath = join(wsPath, "AGENTS.md");
  const atcDir = join(wsPath, ".atc");
  const atcConfigPath = join(atcDir, "config.toml");

  if (process.env.CC_DISCORD_MCP_JSON) {
    const rendered = process.env.CC_DISCORD_MCP_JSON
      .replace(/\{namespace\}/g, ns)
      .replace(/\{workspacePath\}/g, wsPath)
      .replace(/\{token\}/g, token);
    writeFileSync(mcpPath, rendered, "utf8");
    console.log(`[meta-agent-manager] injected MCP config (from CC_DISCORD_MCP_JSON) for ${ns}`);
  } else {
    const npmCache = process.env.npm_config_cache ?? `${homedir()}/.npm`;
    const systemPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";

    const config = {
      mcpServers: {
        "gitkb": {
          command: "/opt/homebrew/bin/git-kb",
          args: ["mcp"],
          env: {
            GITKB_ROOT: wsPath,
            ATC_ROOT: process.env.ATC_ROOT ?? `${homedir()}/.local/share/atc`,
            DISPATCH_KB_ROOT: wsPath,
            DISPATCH_META_ROOT: process.env.DISPATCH_META_ROOT ?? wsPath,
            PATH: systemPath,
            npm_config_cache: npmCache,
          },
        },
      },
    };

    writeFileSync(mcpPath, JSON.stringify(config, null, 2), "utf8");
    console.log(`[meta-agent-manager] injected MCP config for namespace=${ns}`);
  }

  const npmCache = process.env.npm_config_cache ?? `${homedir()}/.npm`;
  const systemPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  mkdirSync(codexDir, { recursive: true });
  mkdirSync(atcDir, { recursive: true });
  writeFileSync(codexConfigPath, [
    "[mcp_servers.gitkb]",
    'command = "/opt/homebrew/bin/git-kb"',
    'args = ["mcp"]',
    "",
    "[mcp_servers.gitkb.env]",
    `GITKB_ROOT = ${JSON.stringify(wsPath)}`,
    `ATC_ROOT = ${JSON.stringify(process.env.ATC_ROOT ?? `${homedir()}/.local/share/atc`)}`,
    `DISPATCH_KB_ROOT = ${JSON.stringify(wsPath)}`,
    `DISPATCH_META_ROOT = ${JSON.stringify(process.env.DISPATCH_META_ROOT ?? wsPath)}`,
    `PATH = ${JSON.stringify(systemPath)}`,
    `npm_config_cache = ${JSON.stringify(npmCache)}`,
    "",
  ].join("\n"), "utf8");
  writeFileSync(atcConfigPath, [
    "[dispatch]",
    "sandbox = false",
    "project_env = true",
    `max_turns = ${Number(process.env.ATC_MAX_TURNS ?? 10000)}`,
    `max_budget_usd = ${Number(process.env.ATC_MAX_BUDGET_USD ?? 250)}`,
    `max_retries = ${Number(process.env.ATC_MAX_RETRIES ?? 1)}`,
    "",
  ].join("\n"), "utf8");
  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, [
      `# ${ns} Agent Workspace`,
      "",
      "- This workspace is managed by cc-discord.",
      "- Use gitkb for project memory.",
      "- Use ATC for spawned or delegated agent work; ATC is a private local/cloud system and must not be vendored, published, or documented as public API.",
      "- ATC command patterns:",
      "  - Implement a task: `GITKB_ROOT=$PWD atc run task <slug>`",
      "  - Research a task: `GITKB_ROOT=$PWD atc run research task <slug>`",
      "  - Review a PR: `GITKB_ROOT=$PWD atc run pr-review --param pr=<url>`",
      "  - Monitor work: `atc status --flat`, `atc logs <slug-or-id>`, `atc watch --id <dispatch-id>`",
      "- Dry-run before dispatch: run `atc run <args> --dry-run`, inspect resolver/directive/worktree/repo, adjust the command, and dry-run again until the output matches intent.",
      "- Never dispatch when the dry-run resolves as raw `prompt` unless raw-prompt dispatch is explicitly intended.",
      "- Keep changes scoped to the registered repository for this Discord namespace.",
      "",
    ].join("\n"), "utf8");
  }
  console.log(`[meta-agent-manager] injected Codex config for namespace=${ns}`);
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

function resolveCodex(): string {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const dirs = (process.env.PATH ?? "").split(":");
  for (const dir of dirs) {
    const c = `${dir}/codex`;
    if (existsSync(c)) return c;
  }
  const fallbacks = [
    `${homedir()}/.npm-global/bin/codex`,
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/usr/bin/codex",
  ];
  for (const p of fallbacks) {
    if (existsSync(p)) return p;
  }
  return "codex";
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
  if (!token) return env;
  if (token.startsWith("sk-ant-api")) {
    env.ANTHROPIC_API_KEY = token;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    env.CLAUDE_CODE_OAUTH_TOKEN = token;
    delete env.ANTHROPIC_API_KEY;
  }
  return env;
}

function codexArgs(message: string, sessionId?: string): string[] {
  const extra = (process.env.CC_DISCORD_CODEX_ARGS ?? "--dangerously-bypass-approvals-and-sandbox")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sessionId) {
    return ["exec", "resume", "--json", "--skip-git-repo-check", ...extra, sessionId, message];
  }
  return ["exec", "--json", "--skip-git-repo-check", ...extra, message];
}

function codexAppServerArgs(): string[] {
  const extra = (process.env.CC_DISCORD_CODEX_SERVER_ARGS ?? "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return ["app-server", "--stdio", ...extra];
}

function codexThreadParams(wsPath: string): JsonRecord {
  return {
    cwd: wsPath,
    approvalPolicy: process.env.CC_DISCORD_CODEX_APPROVAL_POLICY ?? "never",
    sandbox: process.env.CC_DISCORD_CODEX_SANDBOX ?? "danger-full-access",
  };
}

function codexTurnParams(threadId: string, message: string, wsPath: string): JsonRecord {
  return {
    threadId,
    cwd: wsPath,
    approvalPolicy: process.env.CC_DISCORD_CODEX_APPROVAL_POLICY ?? "never",
    sandboxPolicy: { type: "dangerFullAccess" },
    input: [{ type: "text", text: message, text_elements: [] }],
  };
}

function publishDiscordEvent(wire: Wire, ns: string, driver: AgentDriver, event: string, content = ""): void {
  wire._redis.publish(discordChatOutgoing(ns), JSON.stringify({
    id: crypto.randomUUID(),
    source: driver,
    role: "assistant",
    content,
    event,
    timestamp: new Date().toISOString(),
    chatId: 0,
  })).catch(() => {});
}

function publishAssistantText(wire: Wire, ns: string, driver: AgentDriver, content: string, logLabel = "publishOutgoing"): void {
  const msg = {
    id: crypto.randomUUID(),
    source: driver,
    role: "assistant" as const,
    content,
    timestamp: new Date().toISOString(),
    chatId: 0,
  };

  if (driver === "codex") {
    wire._redis.publish(discordChatOutgoing(ns), JSON.stringify(msg)).catch((err: Error) => {
      console.warn(`[meta-agent-manager] ${logLabel} failed (ns=${ns}):`, err.message);
    });
    return;
  }

  wire.discord.publishOutgoing(ns, { ...msg, source: CHAT_SOURCE }).catch((err: Error) => {
    console.warn(`[meta-agent-manager] ${logLabel} failed (ns=${ns}):`, err.message);
  });
}

function extractCodexItemText(item: JsonRecord | undefined): string {
  if (!item) return "";
  if (typeof item.text === "string") return item.text;
  const content = item.content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") {
      return (part as { text: string }).text;
    }
    return "";
  }).join("");
}

const codexDeltaItemIds = new Set<string>();

function forwardCodexAppServerMessage(ns: string, wire: Wire, msg: JsonRecord): void {
  const eventJson = JSON.stringify(msg);
  const rawRedis = wire._redis;
  const streamCh = metaStreamChannel(ns);
  const logKey = metaLogKey(ns);

  rawRedis.publish(streamCh, eventJson).catch((err: Error) => {
    console.warn(`[meta-agent-manager] codex stream publish failed (ns=${ns}):`, err.message);
  });
  rawRedis.lpush(logKey, eventJson).then(() => {
    rawRedis.ltrim(logKey, 0, 1999).catch(() => {});
  }).catch((err: Error) => {
    console.warn(`[meta-agent-manager] codex log lpush failed (ns=${ns}):`, err.message);
  });

  const method = typeof msg.method === "string" ? msg.method : "";
  const params = (msg.params && typeof msg.params === "object") ? msg.params as JsonRecord : {};

  if (method === "item/agentMessage/delta" && typeof params.delta === "string" && params.delta) {
    if (typeof params.itemId === "string") codexDeltaItemIds.add(`${ns}:${params.itemId}`);
    publishAssistantText(wire, ns, "codex", params.delta, "codex delta publishOutgoing");
    return;
  }

  if (method === "item/started") {
    const item = params.item as JsonRecord | undefined;
    const itemType = typeof item?.type === "string" ? item.type : "";
    if (itemType === "commandExecution" || itemType === "mcpToolCall" || itemType === "dynamicToolCall") {
      const label = typeof item?.command === "string"
        ? item.command
        : typeof item?.tool === "string"
          ? item.tool
          : itemType;
      publishDiscordEvent(wire, ns, "codex", "tool_start", label);
    }
    return;
  }

  if (method === "item/completed") {
    const item = params.item as JsonRecord | undefined;
    const itemType = typeof item?.type === "string" ? item.type : "";
    if (itemType === "agentMessage") {
      const itemId = typeof item?.id === "string" ? item.id : "";
      if (itemId && codexDeltaItemIds.has(`${ns}:${itemId}`)) {
        codexDeltaItemIds.delete(`${ns}:${itemId}`);
        return;
      }
      const text = extractCodexItemText(item);
      if (text) {
        publishAssistantText(wire, ns, "codex", text, "codex item publishOutgoing");
      }
    } else if (itemType === "commandExecution" || itemType === "mcpToolCall" || itemType === "dynamicToolCall") {
      publishDiscordEvent(wire, ns, "codex", "tool_end");
    }
    return;
  }

  if (method === "turn/completed") {
    publishDiscordEvent(wire, ns, "codex", "done");
    return;
  }

  if (method === "error" || msg.error) {
    const err = (msg.error && typeof msg.error === "object") ? msg.error as JsonRecord : params;
    const message = typeof err.message === "string" ? err.message : JSON.stringify(err);
    publishAssistantText(wire, ns, "codex", `⚠️ Error: ${message}`, "codex error publishOutgoing");
  }
}

interface CodexAppServerSession {
  proc: ChildProcess;
  ns: string;
  wsPath: string;
  threadId?: string;
  activeTurnId?: string;
  running: boolean;
  queue: string[];
  ready: Promise<void>;
  sendRequest: (method: string, params?: unknown) => Promise<JsonRecord>;
  sendNotification: (method: string, params?: unknown) => void;
  stop: () => void;
}

function spawnCodexAppServerSession(ns: string, token: string, wire: Wire, onExit: () => void): CodexAppServerSession {
  const wsPath = workspacePath(ns);
  const proc = spawn(resolveCodex(), codexAppServerArgs(), {
    cwd: wsPath,
    env: buildEnv(token),
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdin!.setDefaultEncoding("utf8");

  const pending = new Map<number, { resolve: (value: JsonRecord) => void; reject: (err: Error) => void }>();
  let nextId = 1;
  let lineBuffer = "";

  const session: CodexAppServerSession = {
    proc,
    ns,
    wsPath,
    running: false,
    queue: [],
    ready: Promise.resolve(),
    sendRequest(method, params) {
      const id = nextId++;
      const message = { method, id, params };
      return new Promise<JsonRecord>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        proc.stdin!.write(`${JSON.stringify(message)}\n`, (err) => {
          if (err) {
            pending.delete(id);
            reject(err);
          }
        });
      });
    },
    sendNotification(method, params) {
      proc.stdin!.write(`${JSON.stringify({ method, params })}\n`);
    },
    stop() {
      for (const [, waiter] of pending) waiter.reject(new Error("Codex app-server stopped"));
      pending.clear();
      try {
        proc.stdin!.end();
        proc.kill("SIGTERM");
      } catch {
        // ignore shutdown errors
      }
    },
  };

  function handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRecord;
    try {
      msg = JSON.parse(trimmed) as JsonRecord;
    } catch {
      msg = { method: "text", params: { text: trimmed } };
    }

    if (typeof msg.id === "number") {
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        if (msg.error) {
          const err = msg.error as { message?: string };
          waiter.reject(new Error(err.message ?? JSON.stringify(msg.error)));
        } else {
          waiter.resolve(msg);
        }
      }
    }

    const method = typeof msg.method === "string" ? msg.method : "";
    if (method === "turn/started") {
      const params = (msg.params && typeof msg.params === "object") ? msg.params as JsonRecord : {};
      const turn = (params.turn && typeof params.turn === "object") ? params.turn as JsonRecord : {};
      if (typeof turn.id === "string") session.activeTurnId = turn.id;
    } else if (method === "turn/completed") {
      session.activeTurnId = undefined;
    }

    forwardCodexAppServerMessage(ns, wire, msg);
  }

  proc.stdout!.on("data", (chunk: Buffer) => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  });
  proc.stderr!.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) console.log(`[meta-agent-manager:${ns}:codex-stderr] ${text}`);
  });
  proc.on("exit", (code) => {
    if (lineBuffer.trim()) handleLine(lineBuffer);
    for (const [, waiter] of pending) waiter.reject(new Error(`Codex app-server exited with code ${code}`));
    pending.clear();
    console.log(`[meta-agent-manager] codex app-server exited (ns=${ns}, code=${code})`);
    onExit();
  });
  proc.on("error", (err: Error) => {
    for (const [, waiter] of pending) waiter.reject(err);
    pending.clear();
    console.error(`[meta-agent-manager] codex app-server spawn error (ns=${ns}):`, err.message);
    onExit();
  });

  session.ready = (async () => {
    await session.sendRequest("initialize", {
      clientInfo: { name: "cc-discord", title: "cc-discord", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    session.sendNotification("initialized", {});
    const threadResponse = await session.sendRequest("thread/start", codexThreadParams(wsPath));
    const result = (threadResponse.result && typeof threadResponse.result === "object")
      ? threadResponse.result as JsonRecord
      : {};
    const thread = (result.thread && typeof result.thread === "object") ? result.thread as JsonRecord : {};
    if (typeof thread.id !== "string") throw new Error("Codex app-server did not return a thread id");
    session.threadId = thread.id;
  })();

  return session;
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
  driver: AgentDriver = "claude",
  onParsedEvent?: (parsed: Record<string, unknown>) => void,
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
      onParsedEvent?.(parsed);
      const type = parsed.type as string | undefined;
      if (type === "assistant") {
        const content = parsed.message as { content?: Array<{ type: string; text?: string }> } | undefined;
        const textBlock = content?.content?.find((b) => b.type === "text");
        const text = textBlock?.text ?? "";
        structuredEvent = { type: "assistant", text };
        if (text) {
          publishAssistantText(wire, ns, driver, text);
        }
      } else if (type === "tool_use") {
        const toolName = (parsed.name as string) ?? "tool";
        structuredEvent = {
          type: "tool_use",
          name: toolName,
          input: parsed.input ?? {},
        };
        // Ephemeral signal: notifier shows tool activity overlay in the live message
        rawRedis.publish(discordChatOutgoing(ns), JSON.stringify({
          id: crypto.randomUUID(), source: driver, role: "assistant",
          content: toolName, event: "tool_start", timestamp: new Date().toISOString(), chatId: 0,
        })).catch(() => {});
      } else if (type === "tool_result") {
        structuredEvent = {
          type: "tool_result",
          content: parsed.content ?? "",
        };
        // Ephemeral signal: tool finished, notifier can restart finalize timer
        rawRedis.publish(discordChatOutgoing(ns), JSON.stringify({
          id: crypto.randomUUID(), source: driver, role: "assistant",
          content: "", event: "tool_end", timestamp: new Date().toISOString(), chatId: 0,
        })).catch(() => {});
      } else if (type === "result") {
        const resultText = typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result ?? "");
        structuredEvent = {
          type: "result",
          result: resultText,
          is_error: parsed.is_error ?? false,
        };
        if (parsed.is_error && resultText) {
          // Error case: assistant event may not carry the error message — publish it directly
          publishAssistantText(wire, ns, driver, `⚠️ Error: ${resultText}`);
        }
        // Signal turn completion — text was already published via the assistant event above.
        // Do NOT re-publish resultText here: that would double-deliver the same content.
        rawRedis.publish(discordChatOutgoing(ns), JSON.stringify({
          id: crypto.randomUUID(), source: driver, role: "assistant",
          content: "", event: "done", timestamp: new Date().toISOString(), chatId: 0,
        })).catch(() => {});
      } else if (driver === "codex" && type === "item.completed") {
        const item = parsed.item as Record<string, unknown> | undefined;
        const itemType = item?.type as string | undefined;
        const text = typeof item?.text === "string" ? item.text : "";
        structuredEvent = parsed;
        if (itemType === "agent_message" && text) {
          publishAssistantText(wire, ns, "codex", text);
        } else if (itemType === "command_execution" || itemType === "mcp_tool_call") {
          rawRedis.publish(discordChatOutgoing(ns), JSON.stringify({
            id: crypto.randomUUID(), source: driver, role: "assistant",
            content: "", event: "tool_end", timestamp: new Date().toISOString(), chatId: 0,
          })).catch(() => {});
        }
      } else if (driver === "codex" && type === "item.started") {
        const item = parsed.item as Record<string, unknown> | undefined;
        const itemType = item?.type as string | undefined;
        structuredEvent = parsed;
        if (itemType === "command_execution" || itemType === "mcp_tool_call") {
          const label = typeof item?.command === "string" ? item.command : (itemType ?? "tool");
          rawRedis.publish(discordChatOutgoing(ns), JSON.stringify({
            id: crypto.randomUUID(), source: driver, role: "assistant",
            content: label, event: "tool_start", timestamp: new Date().toISOString(), chatId: 0,
          })).catch(() => {});
        }
      } else if (driver === "codex" && (type === "turn.completed" || type === "turn.failed")) {
        structuredEvent = parsed;
        rawRedis.publish(discordChatOutgoing(ns), JSON.stringify({
          id: crypto.randomUUID(), source: driver, role: "assistant",
          content: "", event: "done", timestamp: new Date().toISOString(), chatId: 0,
        })).catch(() => {});
      } else if (driver === "codex" && type === "error") {
        const message = typeof parsed.message === "string" ? parsed.message : JSON.stringify(parsed);
        structuredEvent = parsed;
        publishAssistantText(wire, ns, "codex", `⚠️ Error: ${message}`);
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
    const env = buildEnv(token);
    const driver = agentDriver();

    if (driver === "codex") {
      const proc = spawn(resolveCodex(), codexArgs(message), {
        cwd: wsPath,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      wireStdoutToRedis(proc, ns, wire, "codex");

      proc.on("exit", (code) => {
        console.log(`[meta-agent-manager] codex session exited (ns=${ns}, code=${code})`);
        resolve();
      });

      proc.on("error", (err: Error) => {
        console.error(`[meta-agent-manager] codex spawn error (ns=${ns}):`, err.message);
        reject(err);
      });
      return;
    }

    const claudeBin = resolveClaude();

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
  /** Epoch ms of last stdout data received (or last stdin write). Reset on new input so
   *  the watchdog doesn't kill a session that just got a message but hasn't responded yet. */
  lastOutputAt: number;
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
  onOutput?: () => void,
): ChildProcess {
  const wsPath = workspacePath(ns);
  const claudeBin = resolveClaude();
  const env = buildEnv(token);

  console.log(`[meta-agent-manager] spawning persistent session (ns=${ns})`);

  // --input-format stream-json: Claude reads newline-delimited JSON messages from stdin.
  // Each message must be: {"type":"user","message":{"role":"user","content":"..."}}
  // Claude responds immediately to each message and stays alive waiting for the next one.
  // DO NOT omit --input-format stream-json: without it, Claude ignores stdin when the
  // pipe stays open (no TTY), producing no output until stdin is closed (EOF).
  const proc = spawn(
    claudeBin,
    [
      "--continue",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ],
    { cwd: wsPath, env, stdio: ["pipe", "pipe", "pipe"] }
  );

  proc.stdin!.setDefaultEncoding("utf8");

  wireStdoutToRedis(proc, ns, wire);

  if (onOutput) {
    proc.stdout!.on("data", onOutput);
  }

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
/** Kill a session after this many ms of no stdout (or no new stdin). */
const SESSION_INACTIVITY_MS = 5 * 60_000; // 5 minutes

export function createMetaAgentManager(): MetaAgentManager {
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let watchdogInterval: ReturnType<typeof setInterval> | null = null;
  /** One persistent ChildProcess per namespace. */
  const sessions = new Map<string, PersistentSession>();
  /** One persistent Codex app-server process per namespace. */
  const codexSessions = new Map<string, CodexAppServerSession>();
  /** Namespaces currently being set up (workspace clone / first spawn). */
  const startingUp = new Set<string>();
  /** Wire reference needed for watchdog notifications. Set in startPolling. */
  let wireRef: Wire | null = null;

  /**
   * Write a line to the stdin of the persistent session for ns.
   * Silently no-ops if no session exists.
   * Resets the inactivity timer so the watchdog doesn't kill a session
   * that just received a message but hasn't responded yet.
   */
  function writeToStdin(ns: string, content: string): void {
    const session = sessions.get(ns);
    if (!session) return;
    try {
      // --input-format stream-json: each message must be a newline-delimited JSON object.
      const jsonMsg = JSON.stringify({ type: "user", message: { role: "user", content } });
      session.proc.stdin!.write(`${jsonMsg}\n`);
      // Reset inactivity timer — the session now has SESSION_INACTIVITY_MS to respond
      session.lastOutputAt = Date.now();
    } catch (err) {
      console.warn(`[meta-agent-manager] stdin write failed (ns=${ns}):`, (err as Error).message);
    }
  }

  /**
   * Watchdog: scan all sessions every 60s. If any session has been silent
   * (no stdout and no new stdin) for SESSION_INACTIVITY_MS, kill it and
   * notify Discord so the user can see why the session went quiet.
   */
  function startWatchdog(): void {
    if (watchdogInterval) return;
    watchdogInterval = setInterval(() => {
      if (!wireRef) return;
      const now = Date.now();
      for (const [ns, session] of sessions) {
        const idleMs = now - session.lastOutputAt;
        if (idleMs < SESSION_INACTIVITY_MS) continue;
        const idleMin = Math.round(idleMs / 60_000);
        console.warn(`[meta-agent-manager] watchdog: ns=${ns} idle ${idleMin}m, killing stuck session`);
        // Notify Discord before killing so the user knows what happened
        const alertMsg = {
          id: crypto.randomUUID(),
          source: "claude" as const,
          role: "assistant" as const,
          content: `⚠️ Session for **${ns}** was idle for ${idleMin} minutes (likely stuck on a tool call). Killed and removed — send any message to restart.`,
          timestamp: new Date().toISOString(),
          chatId: 0,
        };
        wireRef.discord.publishOutgoing(ns, alertMsg).catch((err: Error) => {
          console.warn(`[meta-agent-manager] watchdog publishOutgoing failed (ns=${ns}):`, err.message);
        });
        try {
          session.proc.stdin!.end();
          session.proc.kill("SIGTERM");
        } catch {
          // ignore kill errors
        }
        sessions.delete(ns);
      }
    }, 60_000);
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

  async function popQueueMessage(ns: string, wire: Wire): Promise<string | null> {
    const inputKey = discordMetaInputKey(ns);
    let raw: string | null;
    try {
      raw = await wire._redis.lpop(inputKey);
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      return (JSON.parse(raw) as { content?: string }).content ?? raw;
    } catch {
      return raw;
    }
  }

  async function ensureCodexSession(ns: string, repoUrl: string, token: string, wire: Wire): Promise<CodexAppServerSession> {
    const existing = codexSessions.get(ns);
    if (existing) {
      await existing.ready;
      return existing;
    }

    const wsPath = workspacePath(ns);
    await ensureWorkspace(ns, repoUrl);
    injectMcp(ns, wsPath, token);

    const session = spawnCodexAppServerSession(ns, token, wire, () => {
      codexSessions.delete(ns);
      console.log(`[meta-agent-manager] codex session removed from map (ns=${ns})`);
    });
    codexSessions.set(ns, session);
    await session.ready;
    return session;
  }

  async function runCodexTurn(ns: string, repoUrl: string, token: string, wire: Wire, message: string): Promise<void> {
    const session = await ensureCodexSession(ns, repoUrl, token, wire);
    if (message.trim() === "/compact") {
      await session.sendRequest("thread/compact/start", { threadId: session.threadId });
      return;
    }
    if (!session.threadId) throw new Error("Codex app-server session is missing thread id");

    const response = await session.sendRequest("turn/start", codexTurnParams(session.threadId, message, session.wsPath));
    const result = (response.result && typeof response.result === "object") ? response.result as JsonRecord : {};
    const turn = (result.turn && typeof result.turn === "object") ? result.turn as JsonRecord : {};
    if (typeof turn.id === "string") session.activeTurnId = turn.id;
  }

  async function drainCodexQueue(ns: string, repoUrl: string, token: string, wire: Wire): Promise<void> {
    const session = await ensureCodexSession(ns, repoUrl, token, wire);
    if (session.running) return;
    session.running = true;
    try {
      for (;;) {
        const message = await popQueueMessage(ns, wire);
        if (message == null) break;
        if (session.activeTurnId && session.threadId) {
          await session.sendRequest("turn/steer", {
            threadId: session.threadId,
            expectedTurnId: session.activeTurnId,
            input: [{ type: "text", text: message, text_elements: [] }],
          });
        } else {
          await runCodexTurn(ns, repoUrl, token, wire, message);
        }
      }
      await wire.discord.setStatus(ns, {
        namespace: ns,
        status: "running",
        isTyping: false,
        turnCount: 0,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[meta-agent-manager] drainCodexQueue failed (ns=${ns}):`, (err as Error).message);
    } finally {
      session.running = false;
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

      // Placeholder — filled in after proc is known so the onOutput closure can update it
      let session: PersistentSession;

      const proc = spawnPersistentSession(ns, token, wire,
        () => {
          // On exit: remove from map so next message triggers a respawn
          sessions.delete(ns);
          console.log(`[meta-agent-manager] session removed from map (ns=${ns})`);
        },
        () => {
          // Reset inactivity timer on any stdout data
          if (session) session.lastOutputAt = Date.now();
        },
      );

      session = { proc, ns, lastOutputAt: Date.now() };
      sessions.set(ns, session);

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

      wireRef = wire;
      startWatchdog();

      // Grace period: don't run stale-instance check until 20s after startup.
      // The instance key write (in index.ts "ready" handler) is async — if the poll
      // loop fires before that write completes, this instance sees the OLD key,
      // incorrectly thinks it's stale, and self-destructs (SIGTERM to all sessions).
      const pollStartTime = Date.now();
      const STALE_CHECK_GRACE_MS = 20_000;

      pollInterval = setInterval(() => {
        const namespaces = getNamespaces();
        if (namespaces.length === 0) return;

        for (const { namespace: ns, repoUrl } of namespaces) {
          // Stale-instance check — skip during grace period
          if (instanceId && Date.now() - pollStartTime > STALE_CHECK_GRACE_MS) {
            wire._redis.get(DISCORD_INSTANCE_KEY).then((current) => {
              if (current && current !== instanceId) {
                console.log(`[meta-agent-manager] stale instance detected (current=${current}, ours=${instanceId}) — exiting`);
                process.exit(0);
              }
            }).catch(() => {});
          }

          // If session exists, drain any queued messages
          if (agentDriver() === "codex") {
            const inputKey = discordMetaInputKey(ns);
            wire._redis.llen(inputKey).then(async (queueLen) => {
              if (queueLen === 0) return;
              let token = "";
              try {
                token = await wire.token.getMaster();
              } catch {
                token = process.env.CLAUDE_CODE_OAUTH_TOKEN
                  ?? process.env.CLAUDE_CODE_TOKEN
                  ?? process.env.ANTHROPIC_API_KEY
                  ?? "";
              }
              await drainCodexQueue(ns, repoUrl, token, wire);
            }).catch((err: Error) => {
              console.warn(`[meta-agent-manager] codex llen error (ns=${ns}):`, err.message);
            });
            continue;
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
      if (watchdogInterval) {
        clearInterval(watchdogInterval);
        watchdogInterval = null;
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
      for (const [ns, session] of codexSessions) {
        session.stop();
        codexSessions.delete(ns);
        console.log(`[meta-agent-manager] killed codex session on stop (ns=${ns})`);
      }
      codexSessions.clear();
    },

    killSession(ns) {
      if (agentDriver() === "codex") {
        const session = codexSessions.get(ns);
        if (session) session.stop();
        codexSessions.delete(ns);
        console.log(`[meta-agent-manager] cleared codex session state (ns=${ns})`);
        return;
      }
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
      if (agentDriver() === "codex") {
        if (!wireRef) return;
        wireRef._redis.rpush(discordMetaInputKey(ns), JSON.stringify({
          id: crypto.randomUUID(),
          content: line,
          timestamp: new Date().toISOString(),
          source: "cc-discord",
        })).catch((err: Error) => {
          console.warn(`[meta-agent-manager] codex sendToSession enqueue failed (ns=${ns}):`, err.message);
        });
        return;
      }
      writeToStdin(ns, line);
    },
  };
}

/**
 * Migrate the old meta input key to the new cc-discord key.
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
