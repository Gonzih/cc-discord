/**
 * Loop observability for cc-discord meta-agent channels.
 *
 * When a user sends a goal-oriented message to a meta-agent channel the bot
 * creates a Discord thread on that message, tracks iteration state in Redis,
 * and lets human operators steer the loop via 🔄/✅/❌ reactions.
 *
 * Redis layout:
 *   cca:discord:loop:{channelId}:{threadId}  HASH  TTL 24h
 *     goal            → string
 *     namespace       → string
 *     iteration       → stringified number
 *     max_iterations  → stringified number
 *     thread_id       → string
 *     gate_failures   → JSON array of GateFailure
 */

import type { Redis } from "ioredis";

export interface GateFailure {
  gate: string;
  feedback: string;
  iteration: number;
  confidence: number;
  timestamp: string;
}

export interface LoopState {
  channelId: string;
  threadId: string;
  /** ID of the first message posted inside the thread (reactions live here). */
  goalMessageId: string;
  namespace: string;
  goal: string;
  iteration: number;
  maxIterations: number;
  gateFailures: GateFailure[];
}

export interface EvalReport {
  gate: string;
  passed: boolean;
  feedback: string;
  iteration: number;
  maxIterations: number;
  confidence: number;
}

const LOOP_TTL = 86_400; // 24h in seconds

function loopKey(channelId: string, threadId: string): string {
  return `cca:discord:loop:${channelId}:${threadId}`;
}

// Action-verb heuristic: messages that start with one of these words are treated as goals.
const GOAL_RE = /^(create|build|write|implement|fix|add|make|generate|refactor|set\s+up|update|deploy|run|test|check|migrate|convert|analyze|summarize|extract|draft|scaffold|configure|install|delete|remove|optimize|debug|review|audit|plan|design|port|bump|release)\b/i;

/** Return true when `text` looks like an action goal rather than a question or chat. */
export function isGoalMessage(text: string): boolean {
  return GOAL_RE.test(text.trim());
}

/**
 * Parse an `eval_report` object embedded in a raw notification JSON string.
 * Returns null when the field is absent, malformed, or the input is not JSON.
 */
export function parseEvalReport(raw: string): EvalReport | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const r = parsed.eval_report as Record<string, unknown> | undefined;
    if (!r || typeof r.gate !== "string" || typeof r.passed !== "boolean") return null;
    return {
      gate: r.gate,
      passed: r.passed,
      feedback: typeof r.feedback === "string" ? r.feedback : "",
      iteration: typeof r.iteration === "number" ? r.iteration : 0,
      maxIterations: typeof r.max_iterations === "number" ? r.max_iterations : 0,
      confidence: typeof r.confidence === "number" ? r.confidence : 0,
    };
  } catch {
    return null;
  }
}

export class LoopManager {
  /** channelId → LoopState */
  private activeLoops = new Map<string, LoopState>();
  /** reactionMessageId → channelId — for O(1) lookup on reaction events */
  private reactionMessageMap = new Map<string, string>();

  constructor(private redis: Redis) {}

  async startLoop(
    channelId: string,
    threadId: string,
    goalMessageId: string,
    namespace: string,
    goal: string,
    maxIterations = 10
  ): Promise<LoopState> {
    const state: LoopState = {
      channelId,
      threadId,
      goalMessageId,
      namespace,
      goal,
      iteration: 0,
      maxIterations,
      gateFailures: [],
    };
    this.activeLoops.set(channelId, state);
    this.reactionMessageMap.set(goalMessageId, channelId);

    const key = loopKey(channelId, threadId);
    await this.redis.hset(key, {
      goal,
      namespace,
      iteration: "0",
      max_iterations: String(maxIterations),
      thread_id: threadId,
      gate_failures: "[]",
    });
    await this.redis.expire(key, LOOP_TTL);

    return state;
  }

  isActive(channelId: string): boolean {
    return this.activeLoops.has(channelId);
  }

  getState(channelId: string): LoopState | undefined {
    return this.activeLoops.get(channelId);
  }

  getThreadId(channelId: string): string | undefined {
    return this.activeLoops.get(channelId)?.threadId;
  }

  /** Look up the main channel ID from a reaction message ID. */
  getChannelIdByReactionMessage(messageId: string): string | undefined {
    return this.reactionMessageMap.get(messageId);
  }

  async addGateFailure(channelId: string, failure: GateFailure): Promise<void> {
    const state = this.activeLoops.get(channelId);
    if (!state) return;
    state.gateFailures.push(failure);
    state.iteration++;

    const key = loopKey(channelId, state.threadId);
    await this.redis.hset(key, {
      iteration: String(state.iteration),
      gate_failures: JSON.stringify(state.gateFailures),
    });
    await this.redis.expire(key, LOOP_TTL);
  }

  async endLoop(channelId: string): Promise<void> {
    const state = this.activeLoops.get(channelId);
    if (state) {
      this.reactionMessageMap.delete(state.goalMessageId);
      await this.redis.del(loopKey(channelId, state.threadId));
    }
    this.activeLoops.delete(channelId);
  }
}
