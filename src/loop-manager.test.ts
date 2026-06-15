import { describe, it, expect, vi } from "vitest";
import { isGoalMessage, parseEvalReport, LoopManager } from "./loop-manager.js";

describe("isGoalMessage", () => {
  it("returns true for create", () => expect(isGoalMessage("create a new config file")).toBe(true));
  it("returns true for build", () => expect(isGoalMessage("build the frontend")).toBe(true));
  it("returns true for implement", () => expect(isGoalMessage("implement the login flow")).toBe(true));
  it("returns true for fix", () => expect(isGoalMessage("fix the bug in auth.ts")).toBe(true));
  it("returns true for add", () => expect(isGoalMessage("add tests for router")).toBe(true));
  it("returns true for refactor", () => expect(isGoalMessage("refactor the database layer")).toBe(true));
  it("returns true for set up", () => expect(isGoalMessage("set up CI pipeline")).toBe(true));
  it("returns true for optimize", () => expect(isGoalMessage("optimize the query")).toBe(true));
  it("returns true for review", () => expect(isGoalMessage("review the PR diff")).toBe(true));
  it("returns true with mixed case", () => expect(isGoalMessage("Create a README")).toBe(true));

  it("returns false for questions", () => expect(isGoalMessage("what does the auth module do?")).toBe(false));
  it("returns false for greetings", () => expect(isGoalMessage("hello there")).toBe(false));
  it("returns false for statements", () => expect(isGoalMessage("the tests are failing")).toBe(false));
  it("returns false for how-to", () => expect(isGoalMessage("how does the router work?")).toBe(false));
  it("returns false for explanations", () => expect(isGoalMessage("explain the cron system")).toBe(false));
});

describe("parseEvalReport", () => {
  it("returns null for non-JSON", () => {
    expect(parseEvalReport("plain text")).toBeNull();
  });

  it("returns null when eval_report is absent", () => {
    expect(parseEvalReport(JSON.stringify({ text: "done" }))).toBeNull();
  });

  it("returns null when gate or passed is missing", () => {
    expect(parseEvalReport(JSON.stringify({ eval_report: { gate: "completion" } }))).toBeNull();
    expect(parseEvalReport(JSON.stringify({ eval_report: { passed: true } }))).toBeNull();
  });

  it("returns null when eval_report is not an object", () => {
    expect(parseEvalReport(JSON.stringify({ eval_report: "oops" }))).toBeNull();
  });

  it("parses a valid eval_report", () => {
    const raw = JSON.stringify({
      text: "Gate check",
      eval_report: {
        gate: "completion",
        passed: true,
        feedback: "Task done",
        iteration: 2,
        max_iterations: 5,
        confidence: 0.9,
      },
    });
    expect(parseEvalReport(raw)).toEqual({
      gate: "completion",
      passed: true,
      feedback: "Task done",
      iteration: 2,
      maxIterations: 5,
      confidence: 0.9,
    });
  });

  it("parses failed gate", () => {
    const raw = JSON.stringify({
      eval_report: { gate: "quality", passed: false, feedback: "Needs improvement", iteration: 1, max_iterations: 3, confidence: 0.3 },
    });
    const report = parseEvalReport(raw);
    expect(report?.passed).toBe(false);
    expect(report?.gate).toBe("quality");
  });

  it("uses defaults for missing optional numeric fields", () => {
    const raw = JSON.stringify({ eval_report: { gate: "reality", passed: true } });
    const report = parseEvalReport(raw);
    expect(report?.iteration).toBe(0);
    expect(report?.maxIterations).toBe(0);
    expect(report?.confidence).toBe(0);
    expect(report?.feedback).toBe("");
  });
});

/** Minimal Redis mock for LoopManager tests */
function buildRedisMock() {
  const store = new Map<string, Record<string, string>>();
  const expires = new Map<string, number>();
  const deleted = new Set<string>();

  return {
    hset: vi.fn(async (key: string, fields: Record<string, string>) => {
      const existing = store.get(key) ?? {};
      store.set(key, { ...existing, ...fields });
      return 1;
    }),
    expire: vi.fn(async (key: string, ttl: number) => {
      expires.set(key, ttl);
      return 1;
    }),
    del: vi.fn(async (key: string) => {
      deleted.add(key);
      store.delete(key);
      return 1;
    }),
    _store: store,
    _expires: expires,
    _deleted: deleted,
  };
}

describe("LoopManager", () => {
  it("isActive returns false before startLoop", () => {
    const redis = buildRedisMock();
    const lm = new LoopManager(redis as never);
    expect(lm.isActive("ch-1")).toBe(false);
  });

  it("startLoop stores state and reports isActive", async () => {
    const redis = buildRedisMock();
    const lm = new LoopManager(redis as never);
    const state = await lm.startLoop("ch-1", "th-1", "msg-1", "ns-1", "create a widget");
    expect(lm.isActive("ch-1")).toBe(true);
    expect(state.threadId).toBe("th-1");
    expect(state.goal).toBe("create a widget");
    expect(state.namespace).toBe("ns-1");
    expect(state.iteration).toBe(0);
  });

  it("startLoop persists hash fields with 24h TTL", async () => {
    const redis = buildRedisMock();
    const lm = new LoopManager(redis as never);
    await lm.startLoop("ch-1", "th-1", "msg-1", "ns-1", "build thing");
    expect(redis.hset).toHaveBeenCalled();
    const storedKey = "cca:discord:loop:ch-1:th-1";
    expect(redis._store.has(storedKey)).toBe(true);
    expect(redis._expires.get(storedKey)).toBe(86_400);
  });

  it("getThreadId returns thread after startLoop", async () => {
    const redis = buildRedisMock();
    const lm = new LoopManager(redis as never);
    await lm.startLoop("ch-1", "th-1", "msg-1", "ns-1", "goal");
    expect(lm.getThreadId("ch-1")).toBe("th-1");
  });

  it("getChannelIdByReactionMessage resolves after startLoop", async () => {
    const redis = buildRedisMock();
    const lm = new LoopManager(redis as never);
    await lm.startLoop("ch-1", "th-1", "msg-abc", "ns-1", "goal");
    expect(lm.getChannelIdByReactionMessage("msg-abc")).toBe("ch-1");
  });

  it("addGateFailure increments iteration and persists", async () => {
    const redis = buildRedisMock();
    const lm = new LoopManager(redis as never);
    await lm.startLoop("ch-1", "th-1", "msg-1", "ns-1", "goal");
    await lm.addGateFailure("ch-1", { gate: "quality", feedback: "bad", iteration: 0, confidence: 0.2, timestamp: "2026-01-01" });
    const state = lm.getState("ch-1")!;
    expect(state.iteration).toBe(1);
    expect(state.gateFailures).toHaveLength(1);
    expect(state.gateFailures[0].gate).toBe("quality");
  });

  it("endLoop clears state and deletes Redis key", async () => {
    const redis = buildRedisMock();
    const lm = new LoopManager(redis as never);
    await lm.startLoop("ch-1", "th-1", "msg-1", "ns-1", "goal");
    await lm.endLoop("ch-1");
    expect(lm.isActive("ch-1")).toBe(false);
    expect(lm.getThreadId("ch-1")).toBeUndefined();
    expect(lm.getChannelIdByReactionMessage("msg-1")).toBeUndefined();
    expect(redis._deleted.has("cca:discord:loop:ch-1:th-1")).toBe(true);
  });

  it("addGateFailure is a no-op for unknown channelId", async () => {
    const redis = buildRedisMock();
    const lm = new LoopManager(redis as never);
    await expect(
      lm.addGateFailure("nonexistent", { gate: "x", feedback: "", iteration: 0, confidence: 0, timestamp: "" })
    ).resolves.toBeUndefined();
    expect(redis.hset).not.toHaveBeenCalled();
  });
});
