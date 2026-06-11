# Plan: @gonzih/cc-discord v0.1.1

## Task

Two changes in one PR:
1. **Bug fix**: double-notification when Claude responds — the bot writes to Redis with `source:"claude"`, which the notifier's `pmessage` handler picks up and sends a second Discord message.
2. **Feature**: channel-creation from Discord messages and `/channel` slash command — user types "channel for https://github.com/org/repo" or `/channel repo:URL` to create a new Discord text channel mapped to a meta-agent.

## Root cause of double-notification

`flushSession` (bot.ts:574) calls:
```
this.writeChatMessage("assistant", "claude", text, channelId);
```
`writeChatLog` publishes to `cca:chat:outgoing:{namespace}`. The notifier's `pmessage` handler (notifier.ts:207) checks:
```
if (parsed.source !== "claude") return;
```
So it ONLY forwards messages with `source === "claude"` — which is exactly what the bot just wrote. This causes a second Discord message with the `← [ns]` prefix.

**Fix**: Change the `source` argument in `flushSession`'s `writeChatMessage` call from `"claude"` to `"discord"`. The notifier guard then drops it.

## Channel creation feature

### Approach
- Add `parseChannelCreateIntent(text)` to `router.ts` — detects "channel for https://github.com/org/repo" patterns.
- Add `channelNamespaceMap` to `CcDiscordBot` — tracks created-channel-id → {namespace, repoUrl}.
- In `handleMessage`: check intent first, then check map routing, then existing routing.
- Add `createChannelForRepo` helper that: creates Discord channel, registers mapping, calls `ensureMetaAgent`, replies with confirmation.
- Add `/channel` slash command as an alternative to natural language.

### Message flow in created channels
1. User sends message in a created channel
2. `channelNamespaceMap.has(channelId)` is true → route directly to meta-agent via `routeToMetaAgent`
3. Bot does NOT create a local Claude session for these channels

## Files to touch
- `src/bot.ts` — fix flushSession, add channelNamespaceMap, handleMessage changes, createChannelForRepo, /channel command
- `src/router.ts` — add parseChannelCreateIntent
- `src/router.test.ts` — add parseChannelCreateIntent tests
- `package.json` — version bump 0.1.0 → 0.1.1

## Risks
- `guild.channels.create` requires the bot to have `ManageChannels` permission — will throw if missing; caught and reported to user.
- `ensureMetaAgent` can take up to 10s — reply should come before it completes (async); use fire-and-forget after channel creation confirmation.
- `/channel` slash command needs to be added to the registration list and handler switch.
