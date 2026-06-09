# Plan: @gonzih/cc-discord v0.1.0

## Task
Build a Discord adapter for cc-suite, parallel to cc-tg. The bot connects Discord channels to Claude Code sessions and the cc-agent ecosystem (meta-agents, crons, Redis pub/sub bridge).

## Approach

**Option A: Port cc-tg verbatim, swap Telegram→Discord API**
Trade-offs: Maximum feature parity, fastest path. Discord.js v14 has a different event/interaction model (slash commands via REST+interactionCreate vs. text commands). Session key stays string-based.

**Option B: Start fresh with minimal Discord bot**
Trade-offs: Cleaner code, but loses cc-tg battle-tested patterns (usage-limit retry, cron, meta-agent routing).

**Option C: Thin wrapper that delegates all state to Redis**
Trade-offs: Stateless, horizontally scalable — but over-engineered for a single-user bot.

**Chosen: Option A** — port cc-tg, swap Telegram API for Discord.js v14. Reuse claude.ts, router.ts, cron.ts, voice.ts, tokens.ts verbatim. Adapt formatter.ts (Discord markdown ≈ standard markdown, no HTML). Write new bot.ts and notifier.ts using discord.js v14 patterns.

## Files to touch
- `package.json` — new
- `tsconfig.json` — new (copy cc-tg)
- `src/claude.ts` — verbatim copy
- `src/router.ts` — verbatim copy
- `src/cron.ts` — verbatim copy (chatId: number; Discord snowflakes converted via bitmask)
- `src/voice.ts` — verbatim copy
- `src/tokens.ts` — verbatim copy
- `src/formatter.ts` — adapted (Discord markdown, 2000-char splits)
- `src/bot.ts` — new (CcDiscordBot class, discord.js v14)
- `src/notifier.ts` — new (DiscordNotifier, Redis pub/sub → Discord channels)
- `src/index.ts` — new entry point
- `launchd/com.feral.cc-discord.plist` — launchd service definition

## Risks and unknowns
- Discord snowflake IDs exceed Number.MAX_SAFE_INTEGER — cron.ts uses `chatId: number`. Mitigation: bitmask to 53-bit safe range consistently.
- discord.js v14 requires Node 16.11+; cc-tg targets ES2022 — compatible.
- Slash commands require bot to have `applications.commands` OAuth scope in the guild.
- Discord has a 2000-char message limit vs. Telegram's 4096.
- Voice: Discord sends audio as attachment URLs (no server-side file ID lookup like Telegram). Need to download from attachment.url directly.
