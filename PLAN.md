# Plan: Per-namespace notifyListKey polling (issue #10)

## Task restatement
PR #9 already fixed pub/sub subscriptions and routing for routed namespaces.
The remaining gap: `pollNotifyList` only drains `notifyListKey(primary-namespace)`.
Notifications published to `notifyListKey("simorgh-mobile-app")` are never picked up.

## Root cause
`notifier.ts` creates `const notifyListRedisKey = notifyListKey(namespace)` (primary only)
and a single `setInterval` that calls `pollNotifyList`, which only polls that one key.
`registerRoutedChannelId` subscribes to pub/sub for the routed namespace but never
starts polling its list key.

## Fix
1. Extract `pollOneNamespace(ns, targetChannelId)` helper — drains `notifyListKey(ns)`,
   routes each item to `targetChannelId`. Uses `reverseSnowflakeLookup` / chatId routing
   only for the primary namespace (routed namespaces always go to their registered channelId).
2. Extend `pollNotifyList` to poll primary namespace + iterate `routedChannelIds` for all
   registered routed namespaces.
3. Single `setInterval` (unchanged) calls `pollNotifyList`.
4. Remove the now-unused `notifyListRedisKey` constant.

## Tests
Add a test that verifies `registerRoutedChannelId` causes the poll to drain
`notifyListKey(ns)` and deliver to the registered Discord channelId.
Uses Vitest fake timers + lightweight mocks for Redis and bot.

## Files to touch
- `src/notifier.ts` — core fix
- `src/notifier.test.ts` — new tests
