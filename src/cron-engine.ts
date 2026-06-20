/**
 * CronEngine — Redis-persisted, node-cron–scheduled meta-agent messaging.
 *
 * Redis key schema:
 *   cca:discord:cron:list          — SET of cron IDs
 *   cca:discord:cron:{id}          — HASH with fields:
 *                                      namespace, schedule, message, enabled,
 *                                      fire_count, compact_every,
 *                                      created_at, last_fired_at
 *
 * On each fire:
 *   1. Increment fire_count
 *   2. Duplicate check: LRANGE cca:discord:meta:{ns}:input 0 -1
 *      — skip if the exact message is already queued
 *   3. If fire_count % compact_every === 0: RPUSH /compact first
 *   4. RPUSH JSON entry to cca:discord:meta:{ns}:input
 *   5. Update last_fired_at
 */

import { randomUUID } from "crypto";
import { schedule, validate } from "node-cron";
import type { ScheduledTask } from "node-cron";
import type { Redis } from "ioredis";
import {
  cronListKey,
  cronHashKey,
  discordMetaInputKey as metaInputKey,
} from "@gonzih/cc-wire";

// ─── Redis key helpers ────────────────────────────────────────────────────────

const CRON_LIST_KEY = cronListKey();

/**
 * Temporary key written by the cron engine when it fires a cron.
 * Value is the cronId that fired. TTL 300s.
 * The bot reads this after sending a Discord message to link the message to the cron.
 */
export const cronPendingKey = (ns: string): string => `cca:discord:cron-pending:${ns}`;

/**
 * Key that maps a sent Discord messageId → cronId.
 * Used by the reaction handler to look up which cron to disable.
 * TTL 86400s (24h).
 */
export const CRON_MESSAGE_TTL = 86400;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CronRecord {
  id: string;
  namespace: string;
  schedule: string;
  message: string;
  enabled: boolean;
  fire_count: number;
  compact_every: number;
  created_at: string;
  last_fired_at: string;
}

// ─── CronEngine ──────────────────────────────────────────────────────────────

export class CronEngine {
  private redis: Redis;
  /** Map of cron ID → active node-cron ScheduledTask */
  private tasks = new Map<string, ScheduledTask>();

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * Add a new cron.
   * @param namespace  The meta-agent namespace to push messages to.
   * @param cronSchedule  A standard 5-field cron expression (e.g. "0 * * * *").
   * @param message  Text content to push into the meta-agent input queue.
   * @param compact_every  Push /compact every N fires. Defaults to 10.
   * @returns The created CronRecord, or null if the schedule is invalid.
   */
  async add(
    namespace: string,
    cronSchedule: string,
    message: string,
    compact_every = 10
  ): Promise<CronRecord | null> {
    if (!validate(cronSchedule)) return null;

    const id = randomUUID();
    const now = new Date().toISOString();
    const record: CronRecord = {
      id,
      namespace,
      schedule: cronSchedule,
      message,
      enabled: true,
      fire_count: 0,
      compact_every,
      created_at: now,
      last_fired_at: "",
    };

    await this.saveRecord(record);
    await this.redis.sadd(CRON_LIST_KEY, id);
    this.scheduleTask(record);

    console.log(`[cron-engine] added cron id=${id} ns=${namespace} schedule="${cronSchedule}"`);
    return record;
  }

  /**
   * List all crons stored in Redis.
   */
  async list(): Promise<CronRecord[]> {
    const ids = await this.redis.smembers(CRON_LIST_KEY);
    const records: CronRecord[] = [];
    for (const id of ids) {
      const rec = await this.loadRecord(id);
      if (rec) records.push(rec);
    }
    return records;
  }

  /**
   * Pause a cron (sets enabled=false and stops the node-cron task).
   */
  async pause(id: string): Promise<boolean> {
    const rec = await this.loadRecord(id);
    if (!rec) return false;
    rec.enabled = false;
    await this.saveRecord(rec);
    const task = this.tasks.get(id);
    if (task) {
      await task.stop();
    }
    console.log(`[cron-engine] paused cron id=${id}`);
    return true;
  }

  /**
   * Resume a paused cron (sets enabled=true and re-schedules the task).
   */
  async resume(id: string): Promise<boolean> {
    const rec = await this.loadRecord(id);
    if (!rec) return false;
    rec.enabled = true;
    await this.saveRecord(rec);

    // Re-schedule if not already running
    if (!this.tasks.has(id)) {
      this.scheduleTask(rec);
    } else {
      const task = this.tasks.get(id)!;
      await task.start();
    }
    console.log(`[cron-engine] resumed cron id=${id}`);
    return true;
  }

  /**
   * Delete a cron (stops the task and removes from Redis).
   */
  async delete(id: string): Promise<boolean> {
    const rec = await this.loadRecord(id);
    if (!rec) return false;

    const task = this.tasks.get(id);
    if (task) {
      await task.stop();
      await task.destroy();
      this.tasks.delete(id);
    }

    await this.redis.srem(CRON_LIST_KEY, id);
    await this.redis.del(cronHashKey(id));
    console.log(`[cron-engine] deleted cron id=${id}`);
    return true;
  }

  /**
   * Load all enabled crons from Redis and schedule them.
   * Call once after the bot connects and Redis is ready.
   */
  async start(): Promise<void> {
    const ids = await this.redis.smembers(CRON_LIST_KEY);
    let scheduled = 0;
    for (const id of ids) {
      const rec = await this.loadRecord(id);
      if (!rec) continue;
      if (rec.enabled) {
        this.scheduleTask(rec);
        scheduled++;
      }
    }
    console.log(`[cron-engine] started — loaded ${ids.length} crons, scheduled ${scheduled}`);
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private scheduleTask(rec: CronRecord): void {
    // Destroy any existing task for this ID
    const existing = this.tasks.get(rec.id);
    if (existing) {
      void existing.stop();
      void existing.destroy();
      this.tasks.delete(rec.id);
    }

    const task = schedule(rec.schedule, async () => {
      await this.fire(rec.id);
    }, { noOverlap: true });

    this.tasks.set(rec.id, task);
  }

  /**
   * Execute one cron tick:
   *  1. Reload record (picks up any pause between schedule and fire)
   *  2. Increment fire_count
   *  3. Duplicate check against the input queue
   *  4. Optionally push /compact
   *  5. Push the message
   *  6. Update last_fired_at
   */
  private async fire(id: string): Promise<void> {
    const rec = await this.loadRecord(id);
    if (!rec) {
      console.warn(`[cron-engine] fire: record not found for id=${id}`);
      return;
    }
    if (!rec.enabled) {
      console.log(`[cron-engine] fire: cron id=${id} is disabled — skipping`);
      return;
    }

    const ns = rec.namespace;
    const inputKey = metaInputKey(ns);

    // Increment fire_count
    rec.fire_count += 1;

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
        console.log(`[cron-engine] fire: duplicate detected, skipping push (id=${id} ns=${ns})`);
        await this.saveRecord(rec);
        return;
      }
    } catch (err) {
      console.warn(`[cron-engine] fire: duplicate check failed (id=${id}):`, (err as Error).message);
    }

    // Auto-compact every N fires
    if (rec.compact_every > 0 && rec.fire_count % rec.compact_every === 0) {
      const compactEntry = JSON.stringify({
        id: randomUUID(),
        content: "/compact",
        timestamp: new Date().toISOString(),
        source: "cron",
      });
      try {
        await this.redis.rpush(inputKey, compactEntry);
        console.log(`[cron-engine] fire: pushed /compact (id=${id} ns=${ns} fire_count=${rec.fire_count})`);
      } catch (err) {
        console.warn(`[cron-engine] fire: /compact push failed (id=${id}):`, (err as Error).message);
      }
    }

    // Push the scheduled message
    const entry = JSON.stringify({
      id: randomUUID(),
      content: rec.message,
      timestamp: new Date().toISOString(),
      source: "cron",
    });
    try {
      await this.redis.rpush(inputKey, entry);
      rec.last_fired_at = new Date().toISOString();
      console.log(`[cron-engine] fire: pushed message (id=${id} ns=${ns} fire_count=${rec.fire_count})`);
      // Record which cron fired for this namespace — the bot reads this after
      // sending the Discord message to store the cca:discord:cron-message:{msgId} mapping.
      await this.redis.set(cronPendingKey(ns), id, "EX", 300);
    } catch (err) {
      console.warn(`[cron-engine] fire: push failed (id=${id}):`, (err as Error).message);
    }

    await this.saveRecord(rec);
  }

  /** Write a CronRecord to Redis as a HASH. */
  private async saveRecord(rec: CronRecord): Promise<void> {
    const key = cronHashKey(rec.id);
    await this.redis.hset(key, {
      id: rec.id,
      namespace: rec.namespace,
      schedule: rec.schedule,
      message: rec.message,
      enabled: rec.enabled ? "1" : "0",
      fire_count: String(rec.fire_count),
      compact_every: String(rec.compact_every),
      created_at: rec.created_at,
      last_fired_at: rec.last_fired_at,
    });
  }

  /** Load a CronRecord from Redis. Returns null if the key doesn't exist. */
  private async loadRecord(id: string): Promise<CronRecord | null> {
    const data = await this.redis.hgetall(cronHashKey(id));
    if (!data || !data.id) return null;
    return {
      id: data.id,
      namespace: data.namespace,
      schedule: data.schedule,
      message: data.message,
      enabled: data.enabled === "1",
      fire_count: parseInt(data.fire_count ?? "0", 10),
      compact_every: parseInt(data.compact_every ?? "10", 10),
      created_at: data.created_at ?? "",
      last_fired_at: data.last_fired_at ?? "",
    };
  }
}
