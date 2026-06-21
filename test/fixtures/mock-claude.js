#!/usr/bin/env node
/**
 * Mock Claude binary for integration testing.
 *
 * Modes:
 *   MOCK_CLAUDE_STDIN_MODE=1  — persistent session mode: reads stdin line-by-line,
 *                               writes MOCK_CLAUDE_RESPONSE for each non-empty line,
 *                               stays alive until stdin closes.
 *                               Simulates `claude --continue` persistent sessions.
 *   (default)                  — one-shot: write response and exit.
 *
 * Environment variables:
 *   MOCK_CLAUDE_RESPONSE    — text written to stdout (default: "mock response")
 *   MOCK_CLAUDE_EXIT_CODE   — process exit code (default: 0)
 *   MOCK_CLAUDE_DELAY_MS    — startup delay before first response (default: 0)
 *   MOCK_CLAUDE_STDIN_MODE  — set to "1" for persistent session mode
 *
 * All CLI flags (--continue, -p, --output-format, --verbose,
 * --dangerously-skip-permissions, etc.) are accepted and ignored.
 */

const response = process.env.MOCK_CLAUDE_RESPONSE ?? "mock response";
const exitCode = parseInt(process.env.MOCK_CLAUDE_EXIT_CODE ?? "0", 10);
const delayMs = parseInt(process.env.MOCK_CLAUDE_DELAY_MS ?? "0", 10);
const stdinMode = process.env.MOCK_CLAUDE_STDIN_MODE === "1";

if (stdinMode) {
  // Persistent session mode: respond to each stdin line, stay alive until stdin closes
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.resume();

  const write = () => {
    process.stdout.write(response + "\n");
  };

  process.stdin.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) {
        if (delayMs > 0) {
          setTimeout(write, delayMs);
        } else {
          write();
        }
      }
    }
  });

  process.stdin.on("end", () => {
    process.exit(exitCode);
  });
} else {
  function run() {
    process.stdout.write(response + "\n");
    process.exit(exitCode);
  }

  if (delayMs > 0) {
    setTimeout(run, delayMs);
  } else {
    run();
  }
}
