# Plan: Use cc-wire 0.1.6 types throughout cc-discord

## Task restatement
@gonzih/cc-wire@0.1.6 is now installed. Replace all ad-hoc notification
types/constants in cc-discord with cc-wire imports. Specifically:
1. Use `NotificationPayload` type where payloads are parsed
2. Use `Transport` type in the routing filter
3. Use `notifyListKey` builder for list polling (vs `notifyChannel` for pub/sub)
4. Add routing filter: skip delivery when `routing` is non-empty and doesn't include "discord"
5. Remove local type definitions that duplicate cc-wire exports

## What cc-wire 0.1.6 adds
- `Transport = "discord" | "telegram"` type
- `NotificationPayload` = `{ text, chat_id?, routing?: Transport[], driver?, model?, cost? }`
- `notifyListKey(ns)` — same string as `notifyChannel` but semantically the LIST key
- `notifyPublishCommand(ns, payload)` — shell command builder (not used by cc-discord)

## Key observations
- `NotificationPayload` includes `driver`, `model`, `cost` — so the inline cast
  in `parseNotification()` is now a duplicate and should be replaced
- Local `ChatMessage` has `source: "discord" | ...` (cc-wire has `"telegram"`) — NOT a dup
- Local `ParsedNotification` is the post-parse output (camelCase `chatId`) — NOT a dup
- Routing rule: absent/empty → all transports; non-empty → only those listed

## Files to touch
- `src/notifier.ts` — main changes
- `src/notifier.test.ts` — routing filter tests
- `package.json` — already updated to ^0.1.6

## Approach
1. Import `NotificationPayload`, `Transport`, `notifyListKey` from cc-wire
2. Replace inline type cast in `parseNotification()` with `NotificationPayload`
3. Add routing filter → return `null` when discord is excluded
4. Update `parseNotification` return type to `ParsedNotification | null`
5. Update both callers to skip `null`
6. Rename the local `notifyListKey` variable (conflicts with imported function)
