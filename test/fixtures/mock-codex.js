#!/usr/bin/env node
/**
 * Mock Codex binary for integration testing.
 *
 * Supports:
 *   MOCK_CODEX_RESPONSE    — agent message text (default: "mock codex response")
 *   MOCK_CODEX_EXIT_CODE   — process exit code (default: 0)
 *   MOCK_CODEX_DELAY_MS    — delay before output (default: 0)
 *   MOCK_CODEX_THREAD_ID   — thread id emitted in thread.started
 */

const response = process.env.MOCK_CODEX_RESPONSE ?? "mock codex response";
const exitCode = parseInt(process.env.MOCK_CODEX_EXIT_CODE ?? "0", 10);
const delayMs = parseInt(process.env.MOCK_CODEX_DELAY_MS ?? "0", 10);
const threadId = process.env.MOCK_CODEX_THREAD_ID ?? "019ef000-0000-7000-8000-000000000000";
let turnCounter = 0;

function writeJson(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function handleAppServerLine(line) {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  const id = req.id;

  if (req.method === "initialize") {
    writeJson({ id, result: { userAgent: "mock-codex", platformFamily: "macos", platformOs: "darwin" } });
    return;
  }
  if (req.method === "initialized") return;
  if (req.method === "thread/start") {
    writeJson({ id, result: { thread: { id: threadId } } });
    writeJson({ method: "thread/started", params: { thread: { id: threadId } } });
    return;
  }
  if (req.method === "thread/compact/start") {
    writeJson({ id, result: { threadId } });
    writeJson({ method: "thread/compacted", params: { threadId } });
    return;
  }
  if (req.method === "turn/start" || req.method === "turn/steer") {
    const turnId = req.params?.expectedTurnId ?? `turn_${++turnCounter}`;
    writeJson({ id, result: { turn: { id: turnId } } });
    if (req.method === "turn/start") {
      writeJson({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
    }
    const itemId = `item_${turnCounter}`;
    setTimeout(() => {
      writeJson({
        method: "item/agentMessage/delta",
        params: { threadId, turnId, itemId, delta: response },
      });
      writeJson({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          completedAtMs: Date.now(),
          item: { id: itemId, type: "agentMessage", text: response, phase: null, memoryCitation: null },
        },
      });
      writeJson({ method: "turn/completed", params: { threadId, turn: { id: turnId } } });
    }, delayMs);
  }
}

function runAppServer() {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handleAppServerLine(line);
  });
  process.stdin.on("end", () => process.exit(exitCode));
}

function writeEvents() {
  writeJson({ type: "thread.started", thread_id: threadId });
  writeJson({ type: "turn.started" });
  writeJson({
    type: "item.completed",
    item: { id: "item_1", type: "agent_message", text: response },
  });
  writeJson({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  process.exit(exitCode);
}

if (process.argv.includes("app-server")) {
  runAppServer();
} else {
  setTimeout(writeEvents, delayMs);
}
