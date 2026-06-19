#!/usr/bin/env node
/**
 * Mock Claude binary for integration testing.
 *
 * Environment variables:
 *   MOCK_CLAUDE_RESPONSE  — text written to stdout (default: "mock response")
 *   MOCK_CLAUDE_EXIT_CODE — process exit code (default: 0)
 *   MOCK_CLAUDE_DELAY_MS  — simulated processing delay in ms (default: 0)
 *
 * All CLI flags (--continue, -p, --output-format, --verbose,
 * --dangerously-skip-permissions, etc.) are accepted and ignored.
 */

const response = process.env.MOCK_CLAUDE_RESPONSE ?? "mock response";
const exitCode = parseInt(process.env.MOCK_CLAUDE_EXIT_CODE ?? "0", 10);
const delayMs = parseInt(process.env.MOCK_CLAUDE_DELAY_MS ?? "0", 10);

function run() {
  process.stdout.write(response + "\n");
  process.exit(exitCode);
}

if (delayMs > 0) {
  setTimeout(run, delayMs);
} else {
  run();
}
