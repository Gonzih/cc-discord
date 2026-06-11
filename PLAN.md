# Plan: Full Attachment Handling for cc-discord

## Task
Add complete attachment handling to the Discord bot, matching cc-tg's patterns:
1. **Images** → fetch as base64 → `session.claude.sendImage()`; for meta-agent channels → save to disk + ATTACHMENTS path
2. **Documents/files** → download to `.cc-discord/uploads/` → ATTACHMENTS prompt → route to local session or meta-agent
3. **Audio/voice** → Whisper transcription (already exists) → combine with caption → route to local session or meta-agent; detect `.wav`/`.webm`

## Current state
- `handleVoice` exists: transcribes and sends to local Claude only (no meta-agent, no caption combine)
- `handleImage` exists: fetches base64, sends to local Claude only (no meta-agent, no chat log write)
- No document/file handling at all
- Audio detection missing `.wav`, `.webm`, and `audio/` content-type prefix

## Approach: Extend existing handlers + new handleDocument

1. **handleMessage**: add `.wav`/`.webm`/`audio/` audio detection; add doc check before text check
2. **handleVoice**: combine transcript with caption; add meta-agent routing
3. **handleImage**: add meta-agent routing (save to disk path); add `writeChatMessage`
4. **handleDocument** (new): download → ATTACHMENTS prompt → meta-agent or local session

## Files to touch
- `src/bot.ts` — all changes above
- `src/bot.test.ts` — new file with tests for attachment handling

## Risks
- `msg.attachments.first()` returns undefined on empty collection — guard with `if (docAttachment)`
- `crypto.randomUUID()` already used in bot.ts (safe, Node built-in)
- `mkdirSync` already imported in bot.ts
