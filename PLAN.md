# Plan: Typing indicator when routing to meta-agent

## Task
When a Discord message is routed to a meta-agent via `routeToMetaAgent`, the channel shows
no typing indicator while the agent works. The user sees silence until the response arrives.
Fix: start a repeating typing indicator on the Discord channel when routing to a meta-agent,
and stop it when `flushMetaAgentBuffer` fires in the notifier.

## Approach

The meta-agent path involves two components:
- `bot.ts` — receives the message, calls `routeToMetaAgent` to RPUSH to Redis
- `notifier.ts` — listens for `cca:chat:outgoing:{ns}` pmessage events, buffers chunks,
  and flushes to Discord after 1500ms silence via `flushMetaAgentBuffer`

The `bot` instance is already in scope inside `startNotifier` (first parameter), so the
notifier can call methods on it directly — no new callbacks needed.

### Implementation

**bot.ts:**
1. Add `metaAgentTypingTimers: Map<string, ReturnType<typeof setInterval>>` private field
2. Add private `startMetaAgentTyping(channelId, channel)` — immediate sendTyping + 9s interval
3. Add public `stopMetaAgentTyping(channelId)` — clears and removes the interval
4. Call `startMetaAgentTyping` in the 4 meta-agent routing paths:
   - `handleMessage` (before `routeToMetaAgent`)
   - `handleVoice` (before `routeToMetaAgent`)
   - `handleImage` (before `routeToMetaAgent`)
   - `handleDocument` (before `routeToMetaAgent`)
5. Update `stop()` to also clear `metaAgentTypingTimers`

**notifier.ts:**
1. Call `bot.stopMetaAgentTyping(targetChannelId)` at the top of `flushMetaAgentBuffer`
   (before the early-return guard, so it always clears even if buffer is empty)

## Files to touch
- `src/bot.ts` — 3 new methods + 4 call sites
- `src/notifier.ts` — 1-line addition in `flushMetaAgentBuffer`
- `src/notifier.test.ts` — update `buildMocks()` + add flush-stops-typing test

## Risks
- `sendTyping` can throw on closed channels — already guarded with `.catch(() => {})` everywhere
- Typing timer would run forever if meta-agent never responds (no timeout) — acceptable for now;
  stopMetaAgentTyping is idempotent so a later flush cleans it up
