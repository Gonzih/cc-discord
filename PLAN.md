# Plan: Remove hashtag routing from cc-discord

## Task

Remove the `parseRoutingTag`-based hashtag routing from cc-discord. The bot is broken because
`parseRoutingTag` fires on any message containing `#` and tries to start meta-agents via
`start_meta_agent` (which returns null from the cc-discord context). Channels handle routing —
hashtags are not needed here.

## What to change

### `src/router.ts`
- Remove `parseRoutingTag` function and the `RoutingTag` interface
- Remove the `CallToolFn` export at the top (it's a leftover from Telegram — bot.ts has its own copy)
- Keep `ensureMetaAgent`, `routeToMetaAgent`, `parseChannelCreateIntent`
- Keep imports that are still needed by the kept functions
- Update the file header comment to not mention hashtag routing

### `src/router.test.ts`
- Remove the `describe("parseRoutingTag", ...)` block entirely
- Remove `parseRoutingTag` from the import line
- Keep all `parseChannelCreateIntent` tests

### `src/bot.ts`
- Remove `parseRoutingTag` from the router import
- Remove `metaAgentStatusKey` from the @gonzih/cc-wire import (only used by the channel-name routing block)
- Remove the `#tag / #org/repo routing` block in handleMessage (~lines 373-394)
- Remove the "Channel name → meta-agent namespace routing" block in handleMessage (~lines 396-424)
  — this block auto-routes based on channel name matching a running meta-agent namespace; it also
    uses `routeToMetaAgent` but should be removed because it's implicit/surprising behavior and
    the task says "everything else → local Claude session"
- Keep channelNamespaceMap routing block (explicit channel registration via createChannelForRepo / /channel)
- Keep parseChannelCreateIntent block
- Keep callCcAgentTool (still used by createChannelForRepo / /channel slash command)
- Keep ensureMetaAgent usage in createChannelForRepo and /channel handler

## Routing after this change
1. Message → check `parseChannelCreateIntent` → create new Discord channel for a repo URL
2. Message in a registered channel (channelNamespaceMap) → route to that meta-agent
3. Everything else → local Claude session

## Files to touch
- `src/router.ts`
- `src/router.test.ts`
- `src/bot.ts`
- `package.json` (version bump for publish)

## Risks
- `routeToMetaAgent` and `ensureMetaAgent` are still needed by the channelNamespaceMap block and
  `createChannelForRepo`/`/channel` handler — they must NOT be removed from router.ts
- The `CallToolFn` type exported from router.ts is used by `ensureMetaAgent`'s signature — keep it
  in router.ts (bot.ts has its own copy, that's fine)
