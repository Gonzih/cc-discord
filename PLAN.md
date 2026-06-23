# Plan: Fix ⏰ echo and duplicate notification bugs

## Task (restated)
Two bugs in src/notifier.ts:

1. **Bug 1 — ⏰ echo**: cca:chat:incoming handler echoes ALL incoming messages to Discord
   via `bot.sendToChannelById(targetChannelId, '[from UI]: ${content}')`.
   When a cron fires, the scheduler sends `⏰ cron fired: every 30m` to cca:chat:incoming,
   and it leaks to Discord. The meta-agent still needs the message; only the echo must be suppressed.

2. **Bug 2 — duplicate notifications**: A coordinator notification can arrive via TWO paths:
   - pub/sub (PUBLISH to cca:notify:* channel) → `message` handler → deduped via `checkAndMarkSentSync` (in-memory)
   - Redis list (LPUSH to cca:discord:notify:* list key) → `pollNotifyList` every 5s → deduped via `checkAndMarkSent` (Redis)
   
   These two dedup stores are SEPARATE. When pub/sub fires first (marks in-memory only),
   the list poller runs 5s later and finds nothing in Redis → sends again.
   Same issue in reverse: list poller marks in Redis only; pub/sub marks in-memory only.

## Fix Approach

### Bug 1 — simple guard before echo call (line ~571)
Wrap the echo `sendToChannelById` in a cron-message guard:
```javascript
const isCronMessage = content.startsWith("⏰") || content.includes("[cron]");
if (!isCronMessage) { bot.sendToChannelById(...) }
```

### Bug 2 — cross-path dedup sync
Two-part fix:
A. In `pollOneNamespace` (list poller): check in-memory `checkAndMarkSentSync` FIRST before Redis check.
   In-memory check is populated by pub/sub handler, so if pub/sub fired already, list poller sees dup.
B. In `message` handler (pub/sub): after in-memory mark, also fire-and-forget `checkAndMarkSent` (Redis).
   This ensures list poller's Redis check sees it if Redis-primary dedup is enabled.

## Files to touch
- src/notifier.ts — both fixes
- src/notifier.test.ts — tests for both bugs; update buildMocks with lpush/ltrim/publish; import chatIncomingChannel
