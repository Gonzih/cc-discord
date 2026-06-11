# TODO: Fix channel-namespace routing

- [ ] git checkout -b fix/channel-namespace-routing
- [ ] notifier.ts: fix pmessage fallback — only fall back to money-brain for primary namespace (Bug 1)
- [ ] notifier.ts: dynamic subscribe — when registerRoutedChannelId called, subscribe to notify+incoming for that ns (Bug 3)
- [ ] notifier.ts: update message handler to route notify events for all subscribed namespaces
- [ ] bot.ts: add persistChannelMapping helper — write cca:discord:channel:{channelId} to Redis
- [ ] bot.ts: call persistChannelMapping in createChannelForRepo and /channel slash command (Bug 2)
- [ ] bot.ts: add loadChannelMappings() method — scan Redis on startup, populate channelNamespaceMap+registerRoutedChannelId (Bug 2)
- [ ] bot.ts: call loadChannelMappings in index.ts after notifier starts
- [ ] bot.ts: fix writeChatMessage to use correct namespace for routed channels (Bug 4)
- [ ] notifier.test.ts: add tests for namespace isolation (pmessage doesn't leak to wrong channel)
- [ ] npm test — all tests pass
- [ ] git diff --staged — review every change
- [ ] git commit + push
- [ ] npm run build && npm version patch && npm publish --access public
- [ ] gh pr create + gh pr merge --squash --auto
