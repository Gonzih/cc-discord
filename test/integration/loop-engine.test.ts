/**
 * Integration tests for LoopEngine — Redis-backed interval loop management.
 *
 * Requirements:
 *   - Redis running at REDIS_URL (defaults to redis://localhost:6379/1)
 *
 * DB ISOLATION: Tests run against Redis DB 1 (not DB 0).
 */

if (!process.env.REDIS_URL || !process.env.REDIS_URL.includes("/1")) {
  const base = (process.env.REDIS_URL ?? "redis://localhost:6379").replace(/\/\d+$/, "");
  process.env.REDIS_URL = `${base}/1`;
}

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import Redis from "ioredis";

import { LoopEngine, parseIntervalMs } from "../../src/loop-engine.js";

const REDIS_URL = process.env.REDIS_URL!;
const TEST_NS = "cc-discord-test-loop";

let redis: Redis;
let redisAvailable = false;
const testKeys: string[] = [];

function track(key: string): string {
  testKeys.push(key);
  return key;
}

function metaInputKey(ns: string) {
  return `cca:discord:meta:${ns}:input`;
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
  if (redisAvailable) {
    if (testKeys.length > 0) {
      await redis.del(...testKeys);
    }
    const patterns = [
      "cca:discord:loop:*",
      `cca:discord:meta:${TEST_NS}*`,
      `cca:discord:loop-pending:${TEST_NS}*`,
    ];
    for (const pattern of patterns) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) await redis.del(...keys);
    }
  }
  redis.disconnect();
});

afterEach(async () => {
  if (redisAvailable && testKeys.length > 0) {
    await redis.del(...testKeys);
    testKeys.length = 0;
  }
});

// ─── parseIntervalMs — pure function, no Redis ────────────────────────────────

describe("parseIntervalMs — human-readable interval parsing", () => {
  it("parses seconds: 30s → 30000", () => {
    expect(parseIntervalMs("30s")).toBe(30_000);
  });

  it("parses minutes: 5m → 300000", () => {
    expect(parseIntervalMs("5m")).toBe(300_000);
  });

  it("parses hours: 1h → 3600000", () => {
    expect(parseIntervalMs("1h")).toBe(3_600_000);
  });

  it("parses days: 7d → 604800000", () => {
    expect(parseIntervalMs("7d")).toBe(604_800_000);
  });

  it("parses milliseconds: 500ms → 500", () => {
    expect(parseIntervalMs("500ms")).toBe(500);
  });

  it("parses decimal minutes: 1.5m → 90000", () => {
    expect(parseIntervalMs("1.5m")).toBe(90_000);
  });

  it("handles whitespace: '  10m ' → 600000", () => {
    expect(parseIntervalMs("  10m ")).toBe(600_000);
  });

  it("returns null for unknown unit: 10x", () => {
    expect(parseIntervalMs("10x")).toBeNull();
  });

  it("returns null for non-numeric input", () => {
    expect(parseIntervalMs("every 5 min")).toBeNull();
  });

  it("returns null for zero value: 0s", () => {
    expect(parseIntervalMs("0s")).toBeNull();
  });

  it("returns null for negative value: -1m", () => {
    expect(parseIntervalMs("-1m")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseIntervalMs("")).toBeNull();
  });
});

// ─── LoopEngine — CRUD ────────────────────────────────────────────────────────

describe("LoopEngine — CRUD operations", () => {
  it("add() persists LoopRecord to Redis HASH + SET and fires immediately", async () => {
    if (!redisAvailable) return;

    const engine = new LoopEngine(redis);
    // Use a very long interval so the timer doesn't fire again during the test
    const intervalMs = 3_600_000; // 1 hour
    const ns = TEST_NS + "-add";
    const inputKey = track(metaInputKey(ns));

    const rec = await engine.add(ns, intervalMs, "check system", 10);
    track("cca:discord:loop:list");
    track(`cca:discord:loop:${rec.id}`);
    track(`cca:discord:loop-pending:${ns}`);

    try {
      expect(rec.namespace).toBe(ns);
      expect(rec.intervalMs).toBe(intervalMs);
      expect(rec.message).toBe("check system");
      expect(rec.status).toBe("active");
      expect(rec.fireCount).toBe(0); // fireCount before fire() increments

      // Verify persisted to Redis HASH
      const data = await redis.hgetall(`cca:discord:loop:${rec.id}`);
      expect(data.namespace).toBe(ns);
      expect(data.message).toBe("check system");
      expect(data.status).toBe("active");
      expect(data.interval_ms).toBe(String(intervalMs));

      // Verify ID in SET
      const members = await redis.smembers("cca:discord:loop:list");
      expect(members).toContain(rec.id);

      // Verify immediate fire — message should be in input queue
      const queued = await redis.lrange(inputKey, 0, -1);
      expect(queued.length).toBeGreaterThan(0);
      const parsed = JSON.parse(queued[queued.length - 1]) as { content: string; source: string };
      expect(parsed.content).toBe("check system");
      expect(parsed.source).toBe("loop");
    } finally {
      engine.stop();
      await engine.delete(rec.id);
    }
  });

  it("list() returns all persisted loops", async () => {
    if (!redisAvailable) return;

    const engine = new LoopEngine(redis);
    const ns = TEST_NS + "-list";
    const r1 = await engine.add(ns, 3_600_000, "msg1", 10);
    const r2 = await engine.add(ns, 7_200_000, "msg2", 20);
    track("cca:discord:loop:list");
    track(`cca:discord:loop:${r1.id}`);
    track(`cca:discord:loop:${r2.id}`);
    track(metaInputKey(ns));
    track(`cca:discord:loop-pending:${ns}`);

    try {
      const all = await engine.list();
      const ids = all.map((r) => r.id);
      expect(ids).toContain(r1.id);
      expect(ids).toContain(r2.id);
    } finally {
      engine.stop();
      await engine.delete(r1.id);
      await engine.delete(r2.id);
    }
  });

  it("pause() sets status=paused in Redis and stops the timer", async () => {
    if (!redisAvailable) return;

    const engine = new LoopEngine(redis);
    const ns = TEST_NS + "-pause";
    const rec = await engine.add(ns, 3_600_000, "hourly check", 10);
    track("cca:discord:loop:list");
    track(`cca:discord:loop:${rec.id}`);
    track(metaInputKey(ns));
    track(`cca:discord:loop-pending:${ns}`);

    try {
      const ok = await engine.pause(rec.id);
      expect(ok).toBe(true);

      const data = await redis.hgetall(`cca:discord:loop:${rec.id}`);
      expect(data.status).toBe("paused");
    } finally {
      engine.stop();
      await engine.delete(rec.id);
    }
  });

  it("resume() sets status=active and fires immediately", async () => {
    if (!redisAvailable) return;

    const engine = new LoopEngine(redis);
    const ns = TEST_NS + "-resume";
    const inputKey = track(metaInputKey(ns));
    const rec = await engine.add(ns, 3_600_000, "resume test", 10);
    track("cca:discord:loop:list");
    track(`cca:discord:loop:${rec.id}`);
    track(`cca:discord:loop-pending:${ns}`);

    try {
      await engine.pause(rec.id);
      // Clear the queue so we can detect the resume fire clearly
      await redis.del(inputKey);

      const ok = await engine.resume(rec.id);
      expect(ok).toBe(true);

      const data = await redis.hgetall(`cca:discord:loop:${rec.id}`);
      expect(data.status).toBe("active");

      // resume() fires immediately
      const queued = await redis.lrange(inputKey, 0, -1);
      expect(queued.length).toBeGreaterThan(0);
    } finally {
      engine.stop();
      await engine.delete(rec.id);
    }
  });

  it("delete() removes HASH and SET membership", async () => {
    if (!redisAvailable) return;

    const engine = new LoopEngine(redis);
    const ns = TEST_NS + "-delete";
    const rec = await engine.add(ns, 3_600_000, "to be deleted", 10);
    track("cca:discord:loop:list");
    track(metaInputKey(ns));
    track(`cca:discord:loop-pending:${ns}`);

    engine.stop();
    const ok = await engine.delete(rec.id);
    expect(ok).toBe(true);

    const data = await redis.hgetall(`cca:discord:loop:${rec.id}`);
    expect(Object.keys(data)).toHaveLength(0);

    const members = await redis.smembers("cca:discord:loop:list");
    expect(members).not.toContain(rec.id);
  });

  it("delete() returns false for non-existent ID", async () => {
    if (!redisAvailable) return;

    const engine = new LoopEngine(redis);
    const ok = await engine.delete("non-existent-uuid");
    expect(ok).toBe(false);
  });

  it("start() reloads active loops from Redis in new engine instance", async () => {
    if (!redisAvailable) return;

    const ns = TEST_NS + "-start";
    // Engine 1 adds a loop then stops its timers
    const engine1 = new LoopEngine(redis);
    const rec = await engine1.add(ns, 3_600_000, "startup test", 10);
    engine1.stop();
    track("cca:discord:loop:list");
    track(`cca:discord:loop:${rec.id}`);
    track(metaInputKey(ns));
    track(`cca:discord:loop-pending:${ns}`);

    // Engine 2 starts from scratch, reads from Redis
    const engine2 = new LoopEngine(redis);
    await engine2.start();

    try {
      const all = await engine2.list();
      const found = all.find((r) => r.id === rec.id);
      expect(found).toBeDefined();
      expect(found!.status).toBe("active");
    } finally {
      engine2.stop();
      await engine2.delete(rec.id);
    }
  });
});

// ─── LoopEngine — fire behavior ───────────────────────────────────────────────

describe("LoopEngine — fire behavior", () => {
  it("fire() increments fire_count in Redis", async () => {
    if (!redisAvailable) return;

    const engine = new LoopEngine(redis);
    const ns = TEST_NS + "-firecount";
    const rec = await engine.add(ns, 3_600_000, "count me", 100);
    track("cca:discord:loop:list");
    track(`cca:discord:loop:${rec.id}`);
    track(metaInputKey(ns));
    track(`cca:discord:loop-pending:${ns}`);

    try {
      // add() already fired once; fire again manually
      await engine.fire(rec.id);

      const data = await redis.hgetall(`cca:discord:loop:${rec.id}`);
      expect(parseInt(data.fire_count, 10)).toBeGreaterThanOrEqual(2);
    } finally {
      engine.stop();
      await engine.delete(rec.id);
    }
  });

  it("fire() skips paused loops", async () => {
    if (!redisAvailable) return;

    const engine = new LoopEngine(redis);
    const ns = TEST_NS + "-firepause";
    const inputKey = track(metaInputKey(ns));
    const rec = await engine.add(ns, 3_600_000, "paused msg", 100);
    track("cca:discord:loop:list");
    track(`cca:discord:loop:${rec.id}`);
    track(`cca:discord:loop-pending:${ns}`);

    try {
      await engine.pause(rec.id);
      await redis.del(inputKey); // clear queue from add()

      await engine.fire(rec.id);

      const queued = await redis.lrange(inputKey, 0, -1);
      expect(queued.length).toBe(0);
    } finally {
      engine.stop();
      await engine.delete(rec.id);
    }
  });

  it("fire() deduplicates: skips if same message already queued", async () => {
    if (!redisAvailable) return;

    const engine = new LoopEngine(redis);
    const ns = TEST_NS + "-dedup";
    const inputKey = track(metaInputKey(ns));

    // Pre-seed the queue with the same message
    const existing = JSON.stringify({
      id: "pre-existing",
      content: "dedup test msg",
      timestamp: new Date().toISOString(),
      source: "loop",
    });
    await redis.rpush(inputKey, existing);

    const rec = await engine.add(ns, 3_600_000, "dedup test msg", 100);
    track("cca:discord:loop:list");
    track(`cca:discord:loop:${rec.id}`);
    track(`cca:discord:loop-pending:${ns}`);

    try {
      // add() fires immediately but should detect the duplicate
      const queued = await redis.lrange(inputKey, 0, -1);
      // Should still be just the pre-seeded entry (dedup fired)
      const contents = queued.map((e) => (JSON.parse(e) as { content: string }).content);
      expect(contents.filter((c) => c === "dedup test msg")).toHaveLength(1);
    } finally {
      engine.stop();
      await engine.delete(rec.id);
    }
  });

  it("fire() pushes /compact before message on compact_every multiples", async () => {
    if (!redisAvailable) return;

    const engine = new LoopEngine(redis);
    const ns = TEST_NS + "-compact";
    const inputKey = track(metaInputKey(ns));

    // compact_every=1 means EVERY fire triggers /compact
    const rec = await engine.add(ns, 3_600_000, "compact msg", 1);
    track("cca:discord:loop:list");
    track(`cca:discord:loop:${rec.id}`);
    track(`cca:discord:loop-pending:${ns}`);

    try {
      const queued = await redis.lrange(inputKey, 0, -1);
      expect(queued.length).toBeGreaterThanOrEqual(2);

      const first = JSON.parse(queued[0]) as { content: string };
      const second = JSON.parse(queued[1]) as { content: string };
      expect(first.content).toBe("/compact");
      expect(second.content).toBe("compact msg");
    } finally {
      engine.stop();
      await engine.delete(rec.id);
    }
  });

  it("fire() updates last_run in Redis", async () => {
    if (!redisAvailable) return;

    const engine = new LoopEngine(redis);
    const ns = TEST_NS + "-lastrun";
    const rec = await engine.add(ns, 3_600_000, "track run", 100);
    track("cca:discord:loop:list");
    track(`cca:discord:loop:${rec.id}`);
    track(metaInputKey(ns));
    track(`cca:discord:loop-pending:${ns}`);

    try {
      const data = await redis.hgetall(`cca:discord:loop:${rec.id}`);
      expect(data.last_run).toBeTruthy();
      expect(new Date(data.last_run).getTime()).toBeGreaterThan(0);
    } finally {
      engine.stop();
      await engine.delete(rec.id);
    }
  });

  it("stop() clears all timers without modifying Redis", async () => {
    if (!redisAvailable) return;

    const engine = new LoopEngine(redis);
    const ns = TEST_NS + "-stop";
    const rec = await engine.add(ns, 3_600_000, "stop test", 100);
    track("cca:discord:loop:list");
    track(`cca:discord:loop:${rec.id}`);
    track(metaInputKey(ns));
    track(`cca:discord:loop-pending:${ns}`);

    engine.stop();

    // Redis records should still be there
    const data = await redis.hgetall(`cca:discord:loop:${rec.id}`);
    expect(data.id).toBe(rec.id);

    await engine.delete(rec.id);
  });
});
