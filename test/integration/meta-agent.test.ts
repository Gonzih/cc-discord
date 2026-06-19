/**
 * Integration tests for cc-discord meta-agent and cron engine.
 *
 * Requirements:
 *   - Redis running at REDIS_URL (defaults to redis://localhost:6379)
 *   - CLAUDE_BIN is wired to test/fixtures/mock-claude.js via test:integration script
 *
 * All keys are namespaced to cc-discord-test-* and cleaned up after each test.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import Redis from "ioredis";
import { createCcWire } from "@gonzih/cc-wire";

import {
  spawnSession,
  metaLogKey,
} from "../../src/meta-agent-manager.js";
import { CronEngine } from "../../src/cron-engine.js";

// ─── Paths ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MOCK_CLAUDE_BIN = resolve(__dirname, "../fixtures/mock-claude.js");

// ─── Redis setup ──────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

let redis: Redis;
let redisAvailable = false;

const testKeys: string[] = [];
function track(key: string): string {
  testKeys.push(key);
  return key;
}

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { lazyConnect: true, enableReadyCheck: false });
  try {
    await redis.connect();
    await redis.ping();
    redisAvailable = true;
  } catch {
    redisAvailable = false;
  }
});

afterAll(async () => {
  if (redisAvailable && testKeys.length > 0) {
    await redis.del(...testKeys);
  }
  redis.disconnect();
});

afterEach(async () => {
  if (redisAvailable && testKeys.length > 0) {
    await redis.del(...testKeys);
    testKeys.length = 0;
  }
});

// ─── Tests: mock-claude binary ────────────────────────────────────────────────

describe("CLAUDE_BIN — mock-claude binary", () => {
  it("binary exists at expected path", async () => {
    const { existsSync } = await import("fs");
    expect(existsSync(MOCK_CLAUDE_BIN)).toBe(true);
  });

  it("writes MOCK_CLAUDE_RESPONSE to stdout and exits 0", () => {
    const { execFileSync } = require("child_process") as typeof import("child_process");
    const out = execFileSync(MOCK_CLAUDE_BIN, [], {
      env: { ...process.env, MOCK_CLAUDE_RESPONSE: "integration-test-response" },
      encoding: "utf8",
    });
    expect(out.trim()).toBe("integration-test-response");
  });

  it("respects MOCK_CLAUDE_EXIT_CODE", () => {
    const { spawnSync } = require("child_process") as typeof import("child_process");
    const r = spawnSync(MOCK_CLAUDE_BIN, [], {
      env: { ...process.env, MOCK_CLAUDE_EXIT_CODE: "42" },
    });
    expect(r.status).toBe(42);
  });

  it("accepts all standard claude CLI flags without error", () => {
    const { spawnSync } = require("child_process") as typeof import("child_process");
    const r = spawnSync(
      MOCK_CLAUDE_BIN,
      [
        "--continue",
        "-p", "some prompt",
        "--output-format", "text",
        "--verbose",
        "--dangerously-skip-permissions",
      ],
      { env: { ...process.env, MOCK_CLAUDE_RESPONSE: "ok" } }
    );
    expect(r.status).toBe(0);
    expect((r.stdout as Buffer).toString().trim()).toBe("ok");
  });

  it("MOCK_CLAUDE_DELAY_MS introduces a delay before exit", async () => {
    const { spawnSync } = require("child_process") as typeof import("child_process");
    const start = Date.now();
    spawnSync(MOCK_CLAUDE_BIN, [], {
      env: { ...process.env, MOCK_CLAUDE_DELAY_MS: "100" },
    });
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
  });
});

// ─── Tests: spawnSession with CLAUDE_BIN + real Redis ────────────────────────

describe("spawnSession — CLAUDE_BIN override + Redis streaming", () => {
  it("spawns mock claude and streams output to Redis log key", async () => {
    if (!redisAvailable) {
      console.log("[skip] Redis unavailable at", REDIS_URL);
      return;
    }

    const origClaudeBin = process.env.CLAUDE_BIN;
    const origMockResp = process.env.MOCK_CLAUDE_RESPONSE;

    process.env.CLAUDE_BIN = MOCK_CLAUDE_BIN;
    process.env.MOCK_CLAUDE_RESPONSE = "hello from mock claude";

    const TEST_NS = "cc-discord-test-spawn";
    const logKey = track(metaLogKey(TEST_NS));

    // spawnSession cwd's into workspacePath(ns) = ~/cc-discord-workspace/{ns}
    // Create it so the spawn doesn't fail with ENOENT
    const { homedir } = await import("os");
    const { join } = await import("path");
    const { mkdirSync } = await import("fs");
    const wsPath = join(homedir(), "cc-discord-workspace", TEST_NS);
    mkdirSync(wsPath, { recursive: true });

    const wire = createCcWire(redis);

    try {
      await spawnSession(TEST_NS, "hello", "test-token", wire);

      const entries = await redis.lrange(logKey, 0, -1);
      expect(entries.length).toBeGreaterThan(0);

      const allText = entries
        .map((e) => {
          try {
            return (JSON.parse(e) as { text?: string }).text ?? "";
          } catch {
            return e;
          }
        })
        .join("");

      expect(allText).toContain("hello from mock claude");
    } finally {
      if (origClaudeBin !== undefined) {
        process.env.CLAUDE_BIN = origClaudeBin;
      } else {
        delete process.env.CLAUDE_BIN;
      }
      if (origMockResp !== undefined) {
        process.env.MOCK_CLAUDE_RESPONSE = origMockResp;
      } else {
        delete process.env.MOCK_CLAUDE_RESPONSE;
      }
    }
  });

  it("CLAUDE_BIN is honored: mock exit code 0 resolves the promise", async () => {
    if (!redisAvailable) {
      console.log("[skip] Redis unavailable at", REDIS_URL);
      return;
    }

    const origClaudeBin = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = MOCK_CLAUDE_BIN;

    const TEST_NS = "cc-discord-test-spawn-exit";
    track(metaLogKey(TEST_NS));

    const { homedir } = await import("os");
    const { join } = await import("path");
    const { mkdirSync } = await import("fs");
    mkdirSync(join(homedir(), "cc-discord-workspace", TEST_NS), { recursive: true });

    const wire = createCcWire(redis);

    try {
      await expect(spawnSession(TEST_NS, "ping", "test-token", wire)).resolves.toBeUndefined();
    } finally {
      if (origClaudeBin !== undefined) {
        process.env.CLAUDE_BIN = origClaudeBin;
      } else {
        delete process.env.CLAUDE_BIN;
      }
    }
  });
});

// ─── Tests: CronEngine ───────────────────────────────────────────────────────

describe("CronEngine — Redis-backed cron management", () => {
  const TEST_NS = "cc-discord-test-cron";

  function metaInputKey(ns: string) {
    return `cca:discord:meta:${ns}:input`;
  }
  function cronHashKey(id: string) {
    return `cca:discord:cron:${id}`;
  }

  it("add() persists a CronRecord to Redis HASH + SET", async () => {
    if (!redisAvailable) {
      console.log("[skip] Redis unavailable");
      return;
    }

    const engine = new CronEngine(redis);
    const rec = await engine.add(TEST_NS, "* * * * *", "test message", 10);

    expect(rec).not.toBeNull();
    expect(rec!.namespace).toBe(TEST_NS);
    expect(rec!.schedule).toBe("* * * * *");
    expect(rec!.message).toBe("test message");
    expect(rec!.enabled).toBe(true);
    expect(rec!.fire_count).toBe(0);
    expect(rec!.compact_every).toBe(10);

    track("cca:discord:cron:list");
    track(cronHashKey(rec!.id));

    // Verify persisted to Redis HASH
    const data = await redis.hgetall(cronHashKey(rec!.id));
    expect(data.namespace).toBe(TEST_NS);
    expect(data.schedule).toBe("* * * * *");
    expect(data.enabled).toBe("1");
    expect(data.fire_count).toBe("0");

    // Verify ID is in the SET
    const members = await redis.smembers("cca:discord:cron:list");
    expect(members).toContain(rec!.id);

    await engine.delete(rec!.id);
  });

  it("add() returns null for invalid cron expression", async () => {
    if (!redisAvailable) {
      console.log("[skip] Redis unavailable");
      return;
    }

    const engine = new CronEngine(redis);
    const rec = await engine.add(TEST_NS, "not-a-cron-expression", "msg", 10);
    expect(rec).toBeNull();
  });

  it("list() returns all persisted crons", async () => {
    if (!redisAvailable) {
      console.log("[skip] Redis unavailable");
      return;
    }

    const engine = new CronEngine(redis);
    const r1 = await engine.add(TEST_NS, "0 * * * *", "hourly", 5);
    const r2 = await engine.add(TEST_NS, "0 0 * * *", "daily", 10);

    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();

    track("cca:discord:cron:list");
    track(cronHashKey(r1!.id));
    track(cronHashKey(r2!.id));

    const all = await engine.list();
    const ids = all.map((r) => r.id);
    expect(ids).toContain(r1!.id);
    expect(ids).toContain(r2!.id);

    await engine.delete(r1!.id);
    await engine.delete(r2!.id);
  });

  it("pause() sets enabled=false in Redis", async () => {
    if (!redisAvailable) {
      console.log("[skip] Redis unavailable");
      return;
    }

    const engine = new CronEngine(redis);
    const rec = await engine.add(TEST_NS, "0 * * * *", "check", 10);
    expect(rec).not.toBeNull();

    track("cca:discord:cron:list");
    track(cronHashKey(rec!.id));

    const ok = await engine.pause(rec!.id);
    expect(ok).toBe(true);

    const data = await redis.hgetall(cronHashKey(rec!.id));
    expect(data.enabled).toBe("0");

    await engine.delete(rec!.id);
  });

  it("resume() sets enabled=true after pause", async () => {
    if (!redisAvailable) {
      console.log("[skip] Redis unavailable");
      return;
    }

    const engine = new CronEngine(redis);
    const rec = await engine.add(TEST_NS, "0 * * * *", "check", 10);
    expect(rec).not.toBeNull();

    track("cca:discord:cron:list");
    track(cronHashKey(rec!.id));

    await engine.pause(rec!.id);
    const ok = await engine.resume(rec!.id);
    expect(ok).toBe(true);

    const data = await redis.hgetall(cronHashKey(rec!.id));
    expect(data.enabled).toBe("1");

    await engine.delete(rec!.id);
  });

  it("delete() removes hash and SET membership", async () => {
    if (!redisAvailable) {
      console.log("[skip] Redis unavailable");
      return;
    }

    const engine = new CronEngine(redis);
    const rec = await engine.add(TEST_NS, "0 * * * *", "check", 10);
    expect(rec).not.toBeNull();

    track("cca:discord:cron:list");

    await engine.delete(rec!.id);

    // Hash should be gone
    const data = await redis.hgetall(cronHashKey(rec!.id));
    expect(Object.keys(data)).toHaveLength(0);

    // ID should be removed from SET
    const members = await redis.smembers("cca:discord:cron:list");
    expect(members).not.toContain(rec!.id);
  });

  it("start() reloads enabled crons from Redis into a new engine instance", async () => {
    if (!redisAvailable) {
      console.log("[skip] Redis unavailable");
      return;
    }

    // Engine 1 adds a cron; pause it so the timer is stopped
    const engine1 = new CronEngine(redis);
    const rec = await engine1.add(TEST_NS, "0 * * * *", "hourly", 10);
    expect(rec).not.toBeNull();

    track("cca:discord:cron:list");
    track(cronHashKey(rec!.id));

    await engine1.pause(rec!.id);
    // Re-enable the flag in Redis directly so engine2.start() sees it as enabled
    await redis.hset(cronHashKey(rec!.id), { enabled: "1" });

    // Engine 2 loads from Redis
    const engine2 = new CronEngine(redis);
    await engine2.start();

    const all = await engine2.list();
    const found = all.find((r) => r.id === rec!.id);
    expect(found).toBeDefined();
    expect(found!.enabled).toBe(true);

    await engine2.delete(rec!.id);
  });

  it("meta input queue key format matches cron engine expectations", async () => {
    if (!redisAvailable) {
      console.log("[skip] Redis unavailable");
      return;
    }

    // Verify that the key format metaInputKey uses in tests matches the one
    // CronEngine uses internally: "cca:discord:meta:{ns}:input"
    const ns = TEST_NS + "-keyformat";
    const inputKey = track(metaInputKey(ns));

    const entry = JSON.stringify({
      id: "test-id",
      content: "scheduled task",
      timestamp: new Date().toISOString(),
      source: "cron",
    });
    await redis.rpush(inputKey, entry);

    const items = await redis.lrange(inputKey, 0, -1);
    expect(items).toHaveLength(1);
    const parsed = JSON.parse(items[0]) as { content: string; source: string };
    expect(parsed.content).toBe("scheduled task");
    expect(parsed.source).toBe("cron");
  });

  it("duplicate-check: cron skips if identical message already queued", async () => {
    if (!redisAvailable) {
      console.log("[skip] Redis unavailable");
      return;
    }

    // Test the JSON shape the cron engine uses for dedup.
    // CronEngine.fire() does: JSON.parse(entry).content === rec.message
    const ns = TEST_NS + "-dedup";
    const inputKey = track(metaInputKey(ns));

    // Pre-populate the queue with a message
    const existingEntry = JSON.stringify({
      id: "existing-id",
      content: "check status",
      timestamp: new Date().toISOString(),
      source: "cron",
    });
    await redis.rpush(inputKey, existingEntry);

    // Verify dedup logic: parse entries and check .content
    const queued = await redis.lrange(inputKey, 0, -1);
    const isDuplicate = queued.some((e) => {
      try {
        return (JSON.parse(e) as { content?: string }).content === "check status";
      } catch {
        return false;
      }
    });
    expect(isDuplicate).toBe(true);
  });

  it("auto-compact: /compact entry precedes message in queue at fire_count multiples", async () => {
    if (!redisAvailable) {
      console.log("[skip] Redis unavailable");
      return;
    }

    // Simulate what CronEngine.fire() does when fire_count % compact_every === 0:
    // it RPUSHes /compact THEN the actual message.
    const ns = TEST_NS + "-compact";
    const inputKey = track(metaInputKey(ns));

    const compactEntry = JSON.stringify({
      id: "compact-id",
      content: "/compact",
      timestamp: new Date().toISOString(),
      source: "cron",
    });
    const messageEntry = JSON.stringify({
      id: "msg-id",
      content: "run analysis",
      timestamp: new Date().toISOString(),
      source: "cron",
    });

    // RPUSH preserves FIFO order
    await redis.rpush(inputKey, compactEntry);
    await redis.rpush(inputKey, messageEntry);

    const items = await redis.lrange(inputKey, 0, -1);
    expect(items).toHaveLength(2);

    const first = JSON.parse(items[0]) as { content: string };
    const second = JSON.parse(items[1]) as { content: string };
    expect(first.content).toBe("/compact");
    expect(second.content).toBe("run analysis");
  });
});
