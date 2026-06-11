# Plan: Fix Duplicate Notification Delivery

## Task
Cron messages appear in both #cron and #money-brain Discord channels. The root cause is in `src/notifier.ts`: the `pmessage` handler for `cca:chat:outgoing:*` falls back to `notifyChannelId` for the primary namespace (money-brain), forwarding meta-agent output to Discord. Primary namespace chat output belongs to Telegram (cc-tg), not Discord.

## Fix
In the `pmessage` handler, remove the fallback for the primary namespace. Only forward to Discord when `ns` is explicitly registered in `routedChannelIds`:

```typescript
// Before
const targetChannelId = ns === namespace
  ? (routedChannelIds.get(ns) ?? notifyChannelId ?? getActiveChannelId?.())
  : routedChannelIds.get(ns);

// After
const targetChannelId = routedChannelIds.get(ns);
```

## Files to touch
- `src/notifier.ts` — pmessage handler (line ~269)
- `src/notifier.test.ts` — add test verifying primary namespace chat output is dropped

## Risks
- None — this is a targeted 1-line change. Existing tests cover routed namespace behavior.
