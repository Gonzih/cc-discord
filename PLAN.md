# Plan: Fix channel-namespace routing — no cross-namespace leakage

## Task restatement
Responses from the simorgh-mobile-app meta-agent are appearing in the money-brain
Discord channel instead of the simorgh Discord channel. Root causes identified below.

## Root Cause Analysis

### Bug 1 (primary): Wrong fallback in pmessage handler (notifier.ts:247)
When `routedChannelIds.get(ns)` is undefined for a non-primary namespace, the handler
falls back to `notifyChannelId ?? getActiveChannelId()` — both of which point to the
money-brain channel. This happens when the bot restarts (in-memory maps are cleared).

```typescript
// CURRENT — falls back to money-brain for ANY unknown namespace
const targetChannelId = routedChannelIds.get(ns) ?? notifyChannelId ?? getActiveChannelId?.();

// FIX — only fall back for primary namespace; drop for unknown routed namespaces
const targetChannelId = ns === namespace
  ? (routedChannelIds.get(ns) ?? notifyChannelId ?? getActiveChannelId?.())
  : routedChannelIds.get(ns);
```

### Bug 2: Channel mappings not persisted — lost on restart
`channelNamespaceMap` (CcDiscordBot) and `routedChannelIds` (notifier) are in-memory.
After a bot restart:
- simorgh channel messages fall through to local Claude session
- Active simorgh meta-agent responses leak to money-brain (Bug 1)

Fix: persist each channel→namespace mapping to Redis key
`cca:discord:channel:{channelId}` → `{ namespace, repoUrl }`.
Load on startup, repopulate both maps.

### Bug 3: Notifier only subscribes to primary namespace's notify/incoming channels
`startNotifier` subscribes to `cca:notify:money-brain` and `cca:chat:incoming:money-brain`
only. Notifications and UI messages for simorgh are silently dropped.

Fix: when `registerRoutedChannelId(ns, channelId)` is called for a new ns, also
subscribe to `notifyChannel(ns)` and `chatIncomingChannel(ns)`.

### Bug 4 (minor): writeChatMessage uses primary namespace for routed channel messages
In bot.ts `handleMessage`, `writeChatMessage` always calls
`writeChatLog(redis, this.namespace, msg)` — logs simorgh messages under money-brain.
Doesn't cause Discord routing bug directly (source="discord" is dropped by pmessage guard)
but corrupts the chat log. Fix: pass the correct namespace.

## Approach chosen
All four bugs are fixed together. They're all in the same routing path.
Fixing only Bug 1 stops the immediate leakage but messages still get lost after restart.

## Files to touch
- `src/notifier.ts` — Bugs 1, 3 (namespace-aware fallback + dynamic subscription)
- `src/bot.ts` — Bugs 2, 4 (persist/load channel mappings, correct namespace for writeChatMessage)
- `src/notifier.test.ts` — tests for namespace isolation (Bug 1)
- `src/bot.test.ts` — new file: tests for writeChatMessage namespace (Bug 4)

## Key Redis keys added
- `cca:discord:channel:{channelId}` (TTL none) → `{ namespace, repoUrl }` JSON

## Risks
- Loading channel map on startup requires Redis to be ready (already the case — Redis is connected before bot constructs)
- Dynamic subscribe to additional Redis channels must not race with the `sub` reconnect logic — safe, ioredis queues subscribes
- The `message` handler needs to route notify messages for all subscribed namespaces, not just the primary one
