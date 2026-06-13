# Plan: cc-discord v0.2.0 — owns meta-agent runtime directly

## Task
cc-discord takes over meta-agent process management from cc-agent. It clones repos, spawns
`claude --continue` sessions, polls input queues, and publishes output. cc-agent is no longer
involved in meta-agent lifecycle. Upgrade cc-wire to 0.3.0, use discord-scoped Redis keys,
and deliver a new `MetaAgentManager` module.

## Approach

Use cc-wire 0.3.0 key builders (`discordMetaInputKey`, `discordChatOutgoing`, `discordNotify`,
`discordChatLog`) and the `createCcWire(redis)` factory directly — no abstract wrapper.
The factory provides `wire.discord.*`, `wire.tg.*`, `wire.jobs.*`, `wire.token.*` methods.

### Key API discoveries
- `wire.discord.enqueue(ns, msg)` → RPUSH to `cca:discord:meta:{ns}:input`
- `wire.discord.dequeue(ns)` → RPOP from same
- `wire.discord.publishOutgoing(ns, msg)` → PUBLISH + LPUSH to `cca:discord:chat:outgoing:{ns}`
- `wire.discord.setStatus(ns, status)` → SET `cca:discord:meta:{ns}:status`
- `wire.discord.getStatus(ns)` → GET same
- `wire.discord.registerChannel(channelId, ns, repoUrl)` → HSET (replaces old STRING approach)
- `wire.discord.listChannels()` → list all channels from HSET+SET
- `wire.discord.pollNotify(ns)` → RPOP `cca:discord:notify:{ns}`
- `wire.token.getMaster()` / `wire.token.setMaster(token)` → master claude token

### Channel key migration
Old format: `cca:discord:channel:{channelId}` → STRING JSON `{namespace, repoUrl}`
New format: `cca:discord:channel:{channelId}` → HASH with `namespace`, `repoUrl` fields + index SET

On startup: scan old STRING keys, HSET + SADD, DEL old keys.

### Meta input key migration  
Old: `cca:meta:{ns}:input` (used by cc-agent)
New: `cca:discord:meta:{ns}:input`
On startup: LRANGE + RPUSH new key + DEL old key.

### Redis channel name changes in notifier
Old subscribe patterns → new patterns:
- `cca:chat:outgoing:*` → `cca:discord:chat:outgoing:*`  
- `cca:notify:{ns}` → `cca:discord:notify:{ns}`
- `cca:notify:{ns}` (list) → `cca:discord:notify:{ns}`
- `cca:chat:log:{ns}` → `cca:discord:chat:log:{ns}`
- `cca:chat:incoming:{ns}` — NO change (`discordChatIncoming` not in v0.3.0 package)

## Files to touch
- `package.json` — cc-wire ^0.3.0 (already installed)
- `src/meta-agent-manager.ts` (NEW) — ensureWorkspace, injectMcp, spawnSession, pollQueues
- `src/router.ts` — remove ensureMetaAgent, update routeToMetaAgent to use discordMetaInputKey
- `src/notifier.ts` — discord-scoped keys throughout, use createCcWire internally
- `src/bot.ts` — use wire.discord.registerChannel/listChannels, remove ensureMetaAgent calls
- `src/index.ts` — create wire, set master token, run startup migrations, start polling
- `src/notifier.test.ts` — update key names to discord-scoped
- `src/router.test.ts` — no change (only parseChannelCreateIntent tests)
- `src/bot.test.ts` — no change (isAudioAttachment, buildAttachmentPrompt tests)

## MCP injection
Reads `CC_DISCORD_MCP_JSON` env var (JSON template) for full override.
Default template uses the cc-agent MCP server pattern from money-brain/.mcp.json:
npx -y --prefer-online @gonzih/cc-agent with CC_AGENT_NAMESPACE, CWD, token, PATH, cache.

## Risks
- `discordChatIncoming` not exported in v0.3.0 — keep using `chatIncomingChannel` (legacy, still exported)
- Redis STRING→HASH migration must run before loading channel mappings
- Concurrent spawns per namespace: guard with `activeNamespaces: Set<string>`
- `wire.token.getMaster()` throws if not set — guard in spawnSession, fall back to env var
- `claude --continue -p "..."` with `--output-format text` streams text to stdout line by line
