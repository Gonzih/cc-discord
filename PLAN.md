# Plan: Two surgical fixes in src/notifier.ts to reduce Discord noise

## Task (restated)
1. Filter cron-fire events (⏰ prefixed) from Discord notifications in `parseNotification`
2. Filter short coordinator responses (<20 chars) in `flushMetaAgentBuffer`

## Approaches

### A. Return null from parseNotification for cron-fire events + length gate in flushMetaAgentBuffer ← chosen
Direct, minimal changes to existing functions. No new state, no new abstractions.

### B. Pre-filter at Redis poll level
Move filtering to `pollNotifyList`. Slightly more complex, doesn't cover pub/sub path.

### C. Add a NotificationFilter class
Over-engineered for two simple conditions.

## Chosen approach: A

## Files to touch
- `src/notifier.ts` — two targeted edits in `parseNotification` and `flushMetaAgentBuffer`
- `src/notifier.test.ts` — add tests for new filtering behavior

## Risks
- parseNotification is exercised by both pollOneNamespace and pubsub handler — null return covers both
- flushMetaAgentBuffer must clear buf.text/buf.timer before returning early to avoid stale state
