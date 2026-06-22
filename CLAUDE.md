# cc-discord

Discord bot that bridges Discord channels to persistent Claude Code sessions. Each Discord channel maps to a namespace (GitHub repo). One persistent `claude --continue` process per namespace runs in `~/cc-discord-workspace/{ns}/` with MCP tools (gitkb + cc-agent) injected.

**Version:** 0.2.39 | **Entry point:** `src/index.ts`

## Architecture

```
Discord message
  → CcDiscordBot.handleMessage()
  → if registered channel → routeToMetaAgent() → RPUSH cca:discord:meta:{ns}:input
  → if DM/unregistered  → getOrCreateSession() → claude.sendPrompt()

MetaAgentManager (3s poll loop)
  → dequeue from cca:discord:meta:{ns}:input
  → if no session: ensureWorkspace() → injectMcp() → spawn persistent claude --continue
  → write message to stdin of running process
  → wireStdoutToRedis() → PUBLISH cca:meta:{ns}:stream + LPUSH cca:meta:{ns}:log

DiscordNotifier
  → subscribe to cca:discord:chat:outgoing:* (meta-agent stdout → Discord)
  → poll cca:discord:notify:{ns} (job completions → Discord)
  → poll cca:notify:{ns} (legacy pub/sub)
```

## Source Files

| File | Role |
|------|------|
| `src/index.ts` | Entry: env validation, Redis, startup migrations, wire everything |
| `src/bot.ts` | Discord.js client, slash commands, session management, cost tracking |
| `src/meta-agent-manager.ts` | Persistent claude --continue per namespace, stdin/stdout IPC |
| `src/notifier.ts` | Redis pub/sub bridge — forwards job completions + meta-agent output to Discord |
| `src/router.ts` | `routeToMetaAgent()` RPUSH + `parseChannelCreateIntent()` |
| `src/cron-engine.ts` | Redis-persisted cron jobs (node-cron), fires by RPUSH to input queue |
| `src/loop-engine.ts` | Redis-persisted interval loops (setInterval), fires immediately on create/resume |
| `src/claude.ts` | ClaudeProcess — spawn subprocess, parse stream-json, emit events |
| `src/tokens.ts` | Multi-token pool, rotation via `CLAUDE_CODE_OAUTH_TOKENS` |
| `src/formatter.ts` | Discord markdown formatting, message splitting at 2000 chars |
| `src/voice.ts` | Whisper-cpp transcription pipeline (OGG → WAV → text) |
| `src/cron.ts` | Legacy in-memory CronManager (disk-persisted, for backward compat) |

## Key Env Vars

```bash
DISCORD_BOT_TOKEN          # required
CLAUDE_CODE_OAUTH_TOKEN    # required (or ANTHROPIC_API_KEY)
CLAUDE_CODE_OAUTH_TOKENS   # optional, comma-separated pool for rotation
DISCORD_GUILD_IDS          # optional, comma-separated (restricts slash command registration)
DISCORD_ALLOWED_USER_IDS   # optional, comma-separated allowlist
DISCORD_NOTIFY_CHANNEL_ID  # optional, default notification target
CC_AGENT_NAMESPACE         # default: "money-brain"
REDIS_URL                  # default: redis://localhost:6379
CC_DISCORD_MCP_JSON        # optional, full JSON override for .mcp.json template
CLAUDE_BIN                 # optional, override claude binary path (used in tests)
DEFAULT_GITHUB_ORG         # default: gonzih
```

## Slash Commands

| Command | Effect |
|---------|--------|
| `/restart` | `process.exit(0)` — launchd respawns clean |
| `/clear` | Delete Claude JSONL session file in workspace |
| `/compact` | Send `/compact` to session |
| `/cron add` | Add Redis-persisted cron (schedule + task) |
| `/cron list/pause/resume/delete` | Manage crons |
| `/loop add` | Add interval loop (e.g., "30m") |
| `/loop list/pause/resume/delete` | Manage loops |
| `/channel <repo_url>` | Create/register Discord channel for GitHub repo |
| `/costs` | Show token usage + cost breakdown |
| `/reset` | Kill persistent meta-agent session (preserves JSONL — respawns with `--continue` on next message) |
| `/wiki [ns]` | Fetch namespace wiki |

## Cron/Loop Fire Pattern

Both engines fire by **RPUSH into the meta-agent input queue** — they are loop mechanisms, not job spawners. The meta-agent session receives the message as if a user sent it, maintaining full conversation context via `--continue`.

```
CronEngine fires → RPUSH cca:discord:meta:{ns}:input "{task}"
LoopEngine fires → RPUSH cca:discord:meta:{ns}:input "{task}"
MetaAgentManager picks it up → writes to stdin of running session
```

Auto-compact: every `compact_every` fires, also pushes `/compact` first.

## MCP Injection

Written to `{workspace}/.mcp.json` by `injectMcp()`:
```json
{
  "mcpServers": {
    "gitkb": { "command": "/opt/homebrew/bin/git-kb", "args": ["mcp"] },
    "cc-agent": {
      "command": "/opt/homebrew/bin/npx",
      "args": ["-y", "--prefer-online", "@gonzih/cc-agent"],
      "env": { "CC_AGENT_NAMESPACE": "{ns}", "CWD": "{wsPath}", ... }
    }
  }
}
```
Extra servers merged from `~/.config/cc-discord-mcp.json` (gmail, github, etc.).

## Redis Keys

```
cca:discord:meta:{ns}:input      LIST  — queued messages (RPUSH/LPOP)
cca:discord:meta:{ns}:stream     CHAN  — live stdout pub/sub
cca:meta:{ns}:log                LIST  — stdout history (capped 2000, LPUSH)
cca:discord:channel:{channelId}  HASH  — namespace + repoUrl (CRITICAL: camelCase repoUrl)
cca:discord:channels:index       SET   — all registered channel IDs
cca:discord:cron:list            SET   — cron IDs
cca:discord:cron:{id}            HASH  — CronRecord
cca:discord:loop:list            SET   — loop IDs
cca:discord:loop:{id}            HASH  — LoopRecord
cca:discord:notify:{ns}          LIST  — job notifications (polled 5s)
cca:discord:chat:outgoing:{ns}   CHAN  — meta-agent responses (pub/sub)
cca:discord:instance             STR   — singleton UUID (30s TTL, refreshed 10s)
cca:token:master                 STR   — master Claude token (set at startup)
```

**CRITICAL:** Channel hash field is `repoUrl` (camelCase). Using `repo_url` breaks workspace cloning silently.

## Meta-Agent Session Lifecycle

1. First message arrives for namespace → `ensureSession(ns, repoUrl, token, wire)`
2. Clone repo to `~/cc-discord-workspace/{ns}/` (skip if exists)
3. `git-kb init` in workspace (gitkb local KB)
4. Write `.mcp.json`
5. Spawn `claude --continue --output-format stream-json --input-format stream-json` with stdin open
6. Drain queued Redis messages → write each to stdin
7. Stdout → JSONL parser → Redis pub/sub + log list + Discord via notifier
8. On process exit: remove from sessions map; next message respawns

## Singleton Guard

`cca:discord:instance` stores UUID of the running process (30s TTL, refreshed every 10s). On each polling tick, the instance UUID is verified. If it has changed, the process calls `process.exit(0)` — launchd brings up the new instance. This prevents overlap when launchd restarts.

## Testing

```bash
npm test                  # vitest unit tests
npm run test:integration  # integration tests (uses Redis DB 1, CLAUDE_BIN mock)
```

Integration tests use `CLAUDE_BIN=test/fixtures/mock-claude.js`. Mock is configurable via:
- `MOCK_CLAUDE_RESPONSE` — output lines
- `MOCK_CLAUDE_EXIT_CODE` — exit code
- `MOCK_CLAUDE_DELAY_MS` — startup delay
- `MOCK_CLAUDE_STDIN_MODE=1` — persistent session mode: stays alive, responds to each stdin line

Voice tests inject mock binaries via:
- `FFMPEG_BIN` — path to mock-ffmpeg.js fixture
- `WHISPER_BIN` — path to mock-whisper.js fixture
- `WHISPER_MODEL` — path to a dummy model file
- `MOCK_WHISPER_RESPONSE` — text the mock whisper-cli writes to output

**Redis isolation:** Integration tests MUST use Redis DB 1 (`redis://localhost:6379/1`), never DB 0 (production).

## Build & Publish

```bash
npm run build          # tsc → dist/
npm version patch      # bump version
npm publish --access public
```

## Session Architecture

**cc-discord = persistent per channel/repo.** One `claude --continue` process per namespace stays alive across messages. Messages go to stdin; responses stream from stdout. Process survives between Discord messages — context accumulates in the JSONL file.

**cc-agent = transient per job.** Short-lived processes, many in parallel. Each job spawns a new process and exits when done.

**`/reset` vs `/clear`:**
- `/reset` — kills the process only. JSONL preserved. Next message respawns with `--continue`, picking up the same context.
- `/clear` — kills the process AND deletes the JSONL. Next message starts a fresh session with no prior context.

## Voice Transcription (voice.ts)

Pipeline: Discord CDN URL → `downloadFile()` (HTTP + redirect-following + file:// support) → ffmpeg 16kHz mono WAV → whisper-cli → read `.wav.txt` output → strip `[artifacts]` → return text.

Binary search order (first found wins): env var overrides (`FFMPEG_BIN`, `WHISPER_BIN`, `WHISPER_MODEL`) take priority over standard system paths. This allows test injection without modifying system PATH.

## Common Gotchas

- `--continue` flag on claude CLI maintains conversation history via JSONL file in workspace. Deleting the file (`/clear`) starts a fresh session.
- Token type matters: `sk-ant-api*` → `ANTHROPIC_API_KEY`; `sk-ant-oat*` → `CLAUDE_CODE_OAUTH_TOKEN`. Never set both.
- Persistent session stdin protocol: spawn with `--input-format stream-json`, write each message as `{"type":"user","message":{"role":"user","content":"..."}}`. Without `--input-format stream-json`, Claude ignores piped stdin (no TTY) and never responds. Never use plain text or `-p` flag.
- Crons and loops both RPUSH to the same input queue as Discord messages — same processing path.
- `wire.discord.registerChannel()` uses camelCase field names — always use `repoUrl`, never `repo_url`.
- gitkb MCP is ALWAYS injected into meta-agent workspaces via `injectMcp()`. The 0.2.36 failure removed it — 0.2.38+ restores it. Never remove gitkb from the MCP config.
- whisper-cpp `.en.` models require `-l en`, not `-l auto` (auto fails on English-only models).
