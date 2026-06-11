# Plan: Fix channel→namespace mappings lost on cc-discord restart

## Task
Channel→namespace mappings are in-memory only for channels registered via `createChannelForRepo`
or `/channel` slash command. While `persistChannelMapping` is called in those paths, the 4
callsites inside the message-handler methods (`handleMessage`, `handleVoice`, `handleImage`,
`handleDocument`) call `registerRoutedChannelId` but skip `persistChannelMapping`. Additionally,
when a mapping is absent (e.g. after a restart with a lost/never-persisted mapping), the bot
silently falls through to a local Claude session with money-brain context, leaking into the
wrong channel.

## Root Cause
- Only `createChannelForRepo` and the `/channel` slash command call `persistChannelMapping`.
- If a mapping was created by an older bot version (before persist existed) or was evicted from
  Redis, after restart it's gone, and messages fall through to local Claude.

## Approach
Two-part fix (as specified in task brief):

**Part 1 — Persist on use:** In the 4 handler spots where `registerRoutedChannelId` is called
(handleMessage line 463, handleVoice line 508, handleImage line 556, handleDocument line 600),
also call `persistChannelMapping`. This idempotently re-writes the Redis key on each message,
so the mapping survives future restarts.

**Part 2 — Reject unknown guild channels:** In `handleMessage`, after the `mappedNs` block and
before the local Claude fallback, reject guild channels that have no mapping. Reply with a
helpful "not configured" message and return early. DMs (msg.guild == null) still fall through
to local Claude.

## Files to touch
- `src/bot.ts` — 4 callsites for Part 1; add rejection block for Part 2
- `src/bot.test.ts` — add tests for the `stampPrompt` and any new exported helpers
  (Part 2 rejection logic is in private method; tested manually via smoke test)

## Risks
- Part 2 is a UX-breaking change: existing users relying on local Claude sessions in guild
  channels (e.g. the primary money-brain channel) will see "not configured" until they run
  "channel for https://..." to register the channel explicitly.
- DMs are preserved (msg.guild null check).
