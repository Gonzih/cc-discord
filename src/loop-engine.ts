/**
 * LoopEngine — Redis-persisted, interval-based meta-agent messaging.
 *
 * Loops differ from crons:
 *   - Fire IMMEDIATELY on creation and on startup
 *   - Repeat at a fixed millisecond interval (not a cron expression)
 *
 * Redis key schema:
 *   cca:discord:loop:list          — SET of loop IDs
 *   cca:discord:loop:{id}          — HASH with fields:
 *                                      id, namespace, message, interval_ms,
 *                                      fire_count, compact_every, status,
 *                                      last_run, created_at
 *
 * On each fire:
 *   1. Increment fire_count
 *   2. Duplicate check: LRANGE cca:discord:meta:{ns}:input 0 -1
 *      — skip if the exact message is already queued
 *   3. If fire_count % compact_every === 0: RPUSH /compact first
 *   4. RPUSH JSON entry to cca:discord:meta:{ns}:input
 *   5. Update last_run
 */

import { randomUUID } from "crypto";
import type { Redis } from "ioredis";
import {
  loopListKey,
  loopHashKey,
  discordMetaInputKey as metaInputKey,
} from "@gonzih/cc-wire";

// ─── Redis key helpers ────────────────────────────────────────────────────────

const LOOP_LIST_KEY = loopListKey();

/**
 * Temporary key written by the loop engine when it fires a loop.
 * Value is the loopId that fired. TTL 300s.
 * The bot reads this after sending a Discord message to link the message to the loop.
 */
export const loopPendingKey = (ns: string): string => `cca:discord:loop-pending:${ns}`;

/**
 * Key that maps a sent Discord messageId → loopId.
 * Used by the reaction handler to look up which loop to disable.
 * TTL 86400s (24h).
 */
export const LOOP_MESSAGE_TTL = 86400;

// ─── Human-readable interval parsing ─────────────────────────────────────────

/**
 * Parse a human-readable interval string to milliseconds.
 * Supports: 30s, 5m, 20m, 1h, 2h, 1d, 7d, etc.
 * Returns null if the format is unrecognised.
 */
export function parseIntervalMs(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/);
  if (!match) return null;

  const value = parseFloat(match[1]);
  const unit = match[2];

  if (value <= 0 || !isFinite(value)) return null;

  switch (unit) {
    case "ms": return Math.round(value);
    case "s":  return Math.round(value * 1_000);
    case "m":  return Math.round(value * 60_000);
    case "h":  return Math.round(value * 3_600_000);
    case "d":  return Math.round(value * 86_400_000);
    default:   return null;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LoopRecord {
  id: string;
  namespace: string;
  message: string;
  intervalMs: number;
  fireCount: number;
  compactEvery: number;
  status: "active" | "paused";
  lastRun: string;
  createdAt: string;
}

// ─── LoopEngine ───────────────────────────────────────────────────────────────

export class LoopEngine {
  private redis: Redis;
  /** Map of loop ID → NodeJS.Timeout handle */
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * Add a new loop.
   * Fires immediately, then repeats every intervalMs milliseconds.
   *
   * @param namespace   The meta-agent namespace to push messages to.
   * @param intervalMs  Milliseconds between fires.
   * @param message     Text content to push into the meta-agent input queue.
   * @param compactEvery  Push /compact every N fires. Defaults to 10. 0 = never.
   * @returns The created LoopRecord.
   */
  async add(
    namespace: string,
    intervalMs: number,
    message: string,
    compactEvery = 10
  ): Promise<LoopRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: LoopRecord = {
      id,
      namespace,
      message,
      intervalMs,
      fireCount: 0,
      compactEvery,
      status: "active",
      lastRun: "",
      createdAt: now,
    };

    await this.saveRecord(record);
    await this.redis.sadd(LOOP_LIST_KEY, id);

    // Fire immediately, then schedule repeating interval
    await this.fire(id);
    this.startTimer(record);

    console.log(`[loop-engine] added loop id=${id} ns=${namespace} intervalMs=${intervalMs}`);
    return record;
  }

  /**
   * List all loops stored in Redis.
   */
  async list(): Promise<LoopRecord[]> {
    const ids = await this.redis.smembers(LOOP_LIST_KEY);
    const records: LoopRecord[] = [];
    for (const id of ids) {
      const rec = await this.loadRecord(id);
      if (rec) records.push(rec);
    }
    return records;
  }

  /**
   * Pause a loop (sets status=paused and clears the timer).
   */
  async pause(id: string): Promise<boolean> {
    const rec = await this.loadRecord(id);
    if (!rec) return false;
    rec.status = "paused";
    await this.saveRecord(rec);
    this.clearTimer(id);
    console.log(`[loop-engine] paused loop id=${id}`);
    return true;
  }

  /**
   * Resume a paused loop (sets status=active, fires immediately, then restarts timer).
   */
  async resume(id: string): Promise<boolean> {
    const rec = await this.loadRecord(id);
    if (!rec) return false;
    rec.status = "active";
    await this.saveRecord(rec);

    // Fire immediately then start interval
    await this.fire(id);
    this.startTimer(rec);

    console.log(`[loop-engine] resumed loop id=${id}`);
    return true;
  }

  /**
   * Delete a loop (clears timer and removes from Redis).
   */
  async delete(id: string): Promise<boolean> {
    const rec = await this.loadRecord(id);
    if (!rec) return false;

    this.clearTimer(id);
    await this.redis.srem(LOOP_LIST_KEY, id);
    await this.redis.del(loopHashKey(id));
    console.log(`[loop-engine] deleted loop id=${id}`);
    return true;
  }

  /**
   * Load all active loops from Redis, fire each immediately, then start their timers.
   * Call once after the bot connects and Redis is ready.
   */
  async start(): Promise<void> {
    const ids = await this.redis.smembers(LOOP_LIST_KEY);
    let started = 0;
    for (const id of ids) {
      const rec = await this.loadRecord(id);
      if (!rec) continue;
      if (rec.status === "active") {
        await this.fire(id);
        this.startTimer(rec);
        started++;
      }
    }
    console.log(`[loop-engine] started — loaded ${ids.length} loops, started ${started}`);
  }

  /**
   * Stop all running timers. Does not modify Redis.
   */
  stop(): void {
    for (const [id] of this.timers) {
      this.clearTimer(id);
    }
    console.log("[loop-engine] stopped all timers");
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private startTimer(rec: LoopRecord): void {
    // Clear any existing timer for this ID first
    this.clearTimer(rec.id);

    const handle = setInterval(async () => {
      await this.fire(rec.id);
    }, rec.intervalMs);

    this.timers.set(rec.id, handle);
  }

  private clearTimer(id: string): void {
    const handle = this.timers.get(id);
    if (handle !== undefined) {
      clearInterval(handle);
      this.timers.delete(id);
    }
  }

  /**
   * Execute one loop tick:
   *  1. Reload record (picks up any pause between schedule and fire)
   *  2. Increment fireCount
   *  3. Duplicate check against the input queue
   *  4. Optionally push /compact
   *  5. Push the message
   *  6. Update lastRun
   */
  async fire(id: string): Promise<void> {
    const rec = await this.loadRecord(id);
    if (!rec) {
      console.warn(`[loop-engine] fire: record not found for id=${id}`);
      return;
    }
    if (rec.status !== "active") {
      console.log(`[loop-engine] fire: loop id=${id} is paused — skipping`);
      return;
    }

    const ns = rec.namespace;
    const inputKey = metaInputKey(ns);

    // Increment fireCount
    rec.fireCount += 1;

    // Duplicate check: skip if the message is already queued
    try {
      const queued = await this.redis.lrange(inputKey, 0, -1);
      const alreadyQueued = queued.some((entry) => {
        try {
          const parsed = JSON.parse(entry) as { content?: string };
          return parsed.content === rec.message;
        } catch {
          return false;
        }
      });
      if (alreadyQueued) {
        console.log(`[loop-engine] fire: duplicate detected, skipping push (id=${id} ns=${ns})`);
        await this.saveRecord(rec);
        return;
      }
    } catch (err) {
      console.warn(`[loop-engine] fire: duplicate check failed (id=${id}):`, (err as Error).message);
    }

    // Auto-compact every N fires
    if (rec.compactEvery > 0 && rec.fireCount % rec.compactEvery === 0) {
      const compactEntry = JSON.stringify({
        id: randomUUID(),
        content: "/compact",
        timestamp: new Date().toISOString(),
        source: "loop",
      });
      try {
        await this.redis.rpush(inputKey, compactEntry);
        console.log(`[loop-engine] fire: pushed /compact (id=${id} ns=${ns} fireCount=${rec.fireCount})`);
      } catch (err) {
        console.warn(`[loop-engine] fire: /compact push failed (id=${id}):`, (err as Error).message);
      }
    }

    // Push the scheduled message
    const entry = JSON.stringify({
      id: randomUUID(),
      content: rec.message,
      timestamp: new Date().toISOString(),
      source: "loop",
    });
    try {
      await this.redis.rpush(inputKey, entry);
      rec.lastRun = new Date().toISOString();
      console.log(`[loop-engine] fire: pushed message (id=${id} ns=${ns} fireCount=${rec.fireCount})`);
      // Record which loop fired for this namespace
      await this.redis.set(loopPendingKey(ns), id, "EX", 300);
    } catch (err) {
      console.warn(`[loop-engine] fire: push failed (id=${id}):`, (err as Error).message);
    }

    await this.saveRecord(rec);
  }

  /** Write a LoopRecord to Redis as a HASH. */
  private async saveRecord(rec: LoopRecord): Promise<void> {
    const key = loopHashKey(rec.id);
    await this.redis.hset(key, {
      id: rec.id,
      namespace: rec.namespace,
      message: rec.message,
      interval_ms: String(rec.intervalMs),
      fire_count: String(rec.fireCount),
      compact_every: String(rec.compactEvery),
      status: rec.status,
      last_run: rec.lastRun,
      created_at: rec.createdAt,
    });
  }

  /** Load a LoopRecord from Redis. Returns null if the key doesn't exist. */
  private async loadRecord(id: string): Promise<LoopRecord | null> {
    const data = await this.redis.hgetall(loopHashKey(id));
    if (!data || !data.id) return null;
    return {
      id: data.id,
      namespace: data.namespace,
      message: data.message,
      intervalMs: parseInt(data.interval_ms ?? "0", 10),
      fireCount: parseInt(data.fire_count ?? "0", 10),
      compactEvery: parseInt(data.compact_every ?? "10", 10),
      status: (data.status === "paused" ? "paused" : "active") as "active" | "paused",
      lastRun: data.last_run ?? "",
      createdAt: data.created_at ?? "",
    };
  }
}
