# Plan: Include replied-to message content for context resurrection

## Task
When a Discord user replies to a message, prepend the original message content
(truncated to 300 chars) to the text forwarded to Claude so Claude has full context.

## Format
```
> [replying to <AuthorUsername>]: <original message content (truncated to 300 chars)>
<user's actual reply>
```

## Chosen approach: Enrich `text` in `handleMessage` before routing
After `text` is cleaned of @mentions, check `msg.reference?.messageId`, fetch the
referenced message, and prepend the reply prefix to `text`. This single insertion
point naturally covers all downstream paths (meta-agent, local Claude session).

## Files to touch
- `src/bot.ts` — add reply context enrichment in `handleMessage`

## Risks
- `messages.fetch()` may throw if the referenced message is deleted — handled with
  try/catch (silent skip, proceed with original text)
- Referenced message author may have no `member` in DMs — fallback to `author.username`
