# Plan: Fix cc-agent job completion notifications

## Task
Three bugs prevent cc-agent job completion notifications from reaching the meta-agent session:
1. Legacy `cca:notify:{ns}` channel is subscribed but messages are silently dropped
2. `resolveNotifyChannel` falls back to dead `DISCORD_NOTIFY_CHANNEL_ID`; should first look up channelId by namespace from bot's channel map
3. `forwardNotification` receives wrong channelId (dead notify channel) → session lookup fails (fixed by Bug 2)

## Approach

Minimal targeted fixes to the three modules that are broken.

### Bug 1 — notifier.ts
- Import `notifyChannel` from `@gonzih/cc-wire`
- In `subscribeNamespace()`, subscribe to `notifyChannel(ns)` and add to `channelToNamespace`
- In `sub.on("message")`, handle `channel === legacyNotifyCh` exactly like `channel === notifyCh`

### Bug 2 — bot.ts + notifier.ts + index.ts
- Add `getChannelIdForNamespace(ns): string | undefined` to CcDiscordBot (iterate channelNamespaceMap)
- Add optional `getChannelIdForNamespace` param to `resolveNotifyChannel` (after chatId, before notifyChannelId)
- Add optional `getChannelIdForNamespace` param to `startNotifier`, thread it through callers
- Fix `pollNotifyList` primaryTargetId to use namespace lookup first
- Pass `(ns) => bot.getChannelIdForNamespace(ns)` from index.ts

### Bug 3 — verification only
- forwardNotification uses sessionKey(channelId) — once correct channelId is passed (Bug 2 fix), it works

## Files to touch
- `src/notifier.ts` — Bug 1 + Bug 2 (subscribe, handle, resolveNotifyChannel)
- `src/bot.ts` — Bug 2 (getChannelIdForNamespace)
- `src/index.ts` — Bug 2 (pass callback to startNotifier)
- `src/notifier.test.ts` — add tests for legacy channel handling and namespace lookup

## Risks
- Existing `resolveNotifyChannel` tests use 4-arg form; adding optional 5th+6th params is backward-compatible
- Legacy `notifyChannel(ns)` subscribe adds a new Redis subscription per namespace — safe
- `getChannelIdForNamespace` iterates Map on every notification; fine for small channel counts
