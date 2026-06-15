# Plan: Loop Observability Layer for cc-discord

## Task (restated)
Add a "loop observability layer" so that when a meta-agent channel receives a goal-oriented
message, the full iteration cycle (eval reports, gate checks, retries) is visible and
controllable from Discord via a dedicated thread. Main channel stays clean; thread has the
full trace. Human gates (🔄/✅/❌ reactions) route control signals back to the running session.
Loop state is persisted in Redis so it survives restarts.

## Approaches

### A. Thin notifier shim only
Just route loop-tagged notifications to a thread. No thread creation, no goal detection.
Problem: no automatic thread creation means ops must manually set up threads.

### B. Bot-owned LoopManager with full thread lifecycle ← chosen
New `LoopManager` class in bot.ts owns loop state (in-memory + Redis). `isGoalMessage()` heuristic
auto-detects goals. Thread is created via Discord API on the original message. Reactions on the
thread's gate message trigger control signals. Notifier checks `getLoopThreadId(channelId)` to
target thread vs main channel.

### C. External loop daemon via Redis events
Separate process listens to eval report channel, manages thread state. Adds operational complexity
without benefit for this codebase.

## Chosen approach: B

Clean separation: `src/loop-manager.ts` owns the domain types and Redis I/O; `CcDiscordBot` owns
the Discord interactions; `notifier.ts` queries the bot for thread routing. Additive — no changes
to one-shot message flow.

## Files to touch

- `src/loop-manager.ts` — NEW: `LoopState`, `GateFailure`, `EvalReport`, `LoopManager`, `isGoalMessage`, `parseEvalReport`
- `src/bot.ts` — reaction intent, `LoopManager` field, thread creation, reaction handling, `getLoopThreadId`, `postEvalEmbed`
- `src/notifier.ts` — extend `ParsedNotification` with `evalReport`, thread routing in `flushMetaAgentBuffer`/`pollOneNamespace`/pubsub handler
- `src/loop-manager.test.ts` — NEW: unit tests for all loop-manager exports
- `src/notifier.test.ts` — add tests for eval_report parsing and thread routing

## Risks & unknowns

- `msg.startThread()` requires MANAGE_THREADS bot permission in the guild
- Partial reaction events require fetching — handles gracefully with try/catch
- `GatewayIntentBits.GuildMessageReactions` must be added to client intents
- Loop state survives restart only for loops we have in memory; Redis restore on startup is deferred (MVP: in-memory only, Redis TTL 24h for audit trail)
- Eval reports from cc-agent use a non-standard `eval_report` field in the notification JSON — cc-agent must send it; we parse defensively
