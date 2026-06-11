# Plan: @gonzih/cc-discord v0.1.3 — per-channel cron routing

## Task

Route cron completion notifications (`cca:notify:{namespace}`) to the Discord channel that
created the cron, instead of always sending to `DISCORD_NOTIFY_CHANNEL_ID`.

## Current state

- `CronJob.chatId` is already stored as a 53-bit integer (snowflake-derived).
- `storeSnowflake(id)` / `reverseSnowflakeLookup(n)` exist on `CcDiscordBot` (both private).
- The CronManager fire callback already does reverse-lookup → `runCronTask(channelId, ...)`.
- But `notifier.ts` `pollNotifyList` / `sub.on("message")` ignore `chat_id` in the notification
  payload and always route to `notifyChannelId ?? getActiveChannelId()`.

## What needs to change

### 1. bot.ts — ClientReady: pre-populate snowflakeMap
All guild channels visible at login are pre-stored so reverse-lookup works even for channels
that have never sent a message to the bot.

### 2. bot.ts — make reverseSnowflakeLookup public
The notifier needs to call it to turn a chatId integer back into a Discord channel ID string.

### 3. notifier.ts — parseNotification returns {text, chatId?}
Add `chat_id?: number` to the parsed payload type. Return `{ text, chatId }`.
Callers use `.text` for the message and `.chatId` for routing.

### 4. notifier.ts — notify subscriber & pollNotifyList use chatId
When `chatId` is non-zero:
  - call `bot.reverseSnowflakeLookup(chatId)` → channelId
  - fall back to `notifyChannelId ?? getActiveChannelId()` if lookup fails

### 5. notifier.test.ts — update for new return type

### 6. bot.ts — /crons list: show <#channelId> per job
Use reverseSnowflakeLookup to add a channel mention next to each listed cron.

## Files to touch
- `src/bot.ts`
- `src/notifier.ts`
- `src/notifier.test.ts`
- `package.json`

## Risks
- `readyClient.guilds.cache` may not include all guilds if the cache is lazy — channels
  added via `guild.channels.cache` at ClientReady is safe for guilds the bot is already in.
- Notification payloads from cc-agent may use `chat_id` (snake_case) not `chatId` — reading
  `parsed.chat_id` covers this.
- Changing parseNotification return type is a breaking change to the exported API — tests
  and all callers must be updated atomically.
